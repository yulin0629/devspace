#!/usr/bin/env bash
# Build an immutable DevSpace release from a Git ref and switch the user service to it.
#
# Releases live in ~/.local/share/devspace/releases/<version>-<sha12>/ and are never
# modified after build; switching only repoints the service at a different dist/cli.js.
# Works with a systemd user unit (Linux) or a launchd agent (macOS).
#
#   scripts/deploy-release.sh                      # build fork main, switch, restart, health-check
#   scripts/deploy-release.sh --ref feat/x         # any branch, tag or SHA on the remote
#   scripts/deploy-release.sh --build-only         # build the release without switching
#   scripts/deploy-release.sh --rollback           # switch back to the previous release
#   scripts/deploy-release.sh --rollback --to DIR  # switch to a specific release directory
#
# Bootstrap on a machine whose checkout predates this script:
#   git -C ~/github/devspace fetch -q https://github.com/yulin0629/devspace.git main \
#     && git -C ~/github/devspace show FETCH_HEAD:scripts/deploy-release.sh | bash -s --
#
# When run from a shell that DevSpace itself spawned, restarting the service would kill
# this script, so the restart is detached and the health check is skipped; check
# /healthz yourself a few seconds later.
set -euo pipefail

REMOTE="${DEVSPACE_DEPLOY_REMOTE:-https://github.com/yulin0629/devspace.git}"
REF="main"
SOURCE_DIR="${DEVSPACE_SOURCE_DIR:-$HOME/github/devspace}"
RELEASES_DIR="$HOME/.local/share/devspace/releases"
STATE_DIR="$HOME/.local/share/devspace/deploy-state"
SYSTEMD_UNIT="${DEVSPACE_SYSTEMD_UNIT:-devspace}"
MODE="deploy"
ROLLBACK_TO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --build-only) MODE="build"; shift ;;
    --rollback) MODE="rollback"; shift ;;
    --to) ROLLBACK_TO="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
OS="$(uname -s)"
log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

# ---------- service discovery ----------

service_file() {
  if [ "$OS" = "Linux" ]; then
    systemctl --user show -p FragmentPath --value "$SYSTEMD_UNIT"
  else
    local f
    for f in "$HOME"/Library/LaunchAgents/*.plist; do
      grep -q "dist/cli.js" "$f" 2>/dev/null && grep -qi "devspace" "$f" && { echo "$f"; return; }
    done
  fi
}

current_cli() {
  if [ "$OS" = "Linux" ]; then
    grep -o '/[^ ]*/dist/cli\.js' "$SERVICE_FILE" | head -1
  else
    python3 - "$SERVICE_FILE" <<'PY'
import plistlib, sys
args = plistlib.load(open(sys.argv[1], "rb"))["ProgramArguments"]
print(next(a for a in args if a.endswith("/dist/cli.js")))
PY
  fi
}

launchd_label() {
  python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$SERVICE_FILE"
}

service_pid() {
  if [ "$OS" = "Linux" ]; then
    systemctl --user show -p MainPID --value "$SYSTEMD_UNIT"
  else
    launchctl print "gui/$(id -u)/$(launchd_label)" 2>/dev/null | awk '/^\tpid = /{print $3; exit}'
  fi
}

# True when this script descends from the running service (e.g. DevSpace's own bash tool).
inside_service() {
  local target pid
  target="$(service_pid)"
  [ -n "$target" ] && [ "$target" != "0" ] || return 1
  pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$target" ] && return 0
    pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
  done
  return 1
}

# ---------- switching and restarting ----------

set_cli() {
  local new_cli="$1" old_cli
  old_cli="$(current_cli)"
  [ "$old_cli" = "$new_cli" ] && { log "service already points at $new_cli"; return; }
  cp "$SERVICE_FILE" "$SERVICE_FILE.before-deploy"
  if [ "$OS" = "Linux" ]; then
    python3 - "$SERVICE_FILE" "$old_cli" "$new_cli" <<'PY'
import sys
path, old, new = sys.argv[1:4]
text = open(path).read()
assert text.count(old) == 1, f"expected exactly one {old} in {path}"
open(path, "w").write(text.replace(old, new))
PY
    systemctl --user daemon-reload
  else
    python3 - "$SERVICE_FILE" "$new_cli" <<'PY'
import plistlib, sys
path, cli = sys.argv[1:3]
data = plistlib.load(open(path, "rb"))
args = data["ProgramArguments"]
idx = [i for i, a in enumerate(args) if a.endswith("/dist/cli.js")]
assert len(idx) == 1, args
args[idx[0]] = cli  # replace in place; never insert a second entry
plistlib.dump(data, open(path, "wb"))
PY
  fi
  log "service now points at $new_cli"
}

restart_sync() {
  if [ "$OS" = "Linux" ]; then
    systemctl --user restart "$SYSTEMD_UNIT"
  else
    local label i
    label="$(launchd_label)"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    for i in 1 2 3 4 5 6 7 8; do
      sleep 2
      launchctl bootstrap "gui/$(id -u)" "$SERVICE_FILE" 2>/dev/null && return 0
    done
    die "launchctl bootstrap kept failing for $label"
  fi
}

restart_detached() {
  if [ "$OS" = "Linux" ]; then
    systemd-run --user --quiet --on-active=3 --unit="devspace-redeploy-$(date +%s)" \
      systemctl --user restart "$SYSTEMD_UNIT"
  else
    # launchd kills the job's process group on bootout; a new session survives it.
    python3 - "$SERVICE_FILE" "$(launchd_label)" "$(id -u)" <<'PY'
import os, sys, subprocess, time
plist, label, uid = sys.argv[1:4]
if os.fork():
    sys.exit(0)
os.setsid()
if os.fork():
    os._exit(0)
log = open("/tmp/devspace-redeploy.log", "w")
time.sleep(3)
subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], stdout=log, stderr=log)
for _ in range(8):
    time.sleep(2)
    if subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", plist], stdout=log, stderr=log).returncode == 0:
        break
PY
  fi
  log "restart scheduled in ~3s (detached; this shell belongs to the service)"
}

health_check() {
  local release="$1" port i
  port="$(cd "$release" && node --input-type=module -e \
    "import {loadConfig} from './dist/config.js'; console.log(loadConfig().port)")"
  for i in $(seq 1 30); do
    sleep 2
    if curl -fsS -m 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      log "healthy on 127.0.0.1:$port"
      return 0
    fi
  done
  return 1
}

# Switch, restart, verify; on a failed health check put the old release back.
activate() {
  local release="$1" previous
  previous="$(dirname "$(dirname "$(current_cli)")")"
  set_cli "$release/dist/cli.js"
  mkdir -p "$STATE_DIR"
  [ "$previous" != "$release" ] && echo "$previous" > "$STATE_DIR/previous"
  echo "$release" > "$STATE_DIR/current"
  if inside_service; then
    restart_detached
    return
  fi
  restart_sync
  if ! health_check "$release"; then
    log "health check failed; rolling back to $previous"
    set_cli "$previous/dist/cli.js"
    echo "$previous" > "$STATE_DIR/current"
    restart_sync
    health_check "$previous" || log "previous release is not healthy either"
    die "deploy of $release failed"
  fi
}

# ---------- build ----------

ensure_pnpm() {
  command -v pnpm >/dev/null 2>&1 && return
  local shim_dir pm
  shim_dir="$(mktemp -d)"
  pm="$(python3 -c 'import json;print(json.load(open("package.json")).get("packageManager","pnpm"))')"
  if command -v corepack >/dev/null 2>&1; then
    printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$shim_dir/pnpm"
  else
    printf '#!/bin/sh\nexec npx -y %s "$@"\n' "$pm" > "$shim_dir/pnpm"
  fi
  chmod +x "$shim_dir/pnpm"
  export PATH="$shim_dir:$PATH"
}

build_release() {
  [ -d "$SOURCE_DIR/.git" ] || die "no Git checkout at $SOURCE_DIR (set --source)"
  git -C "$SOURCE_DIR" fetch -q "$REMOTE" "$REF"
  local sha version release
  sha="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
  version="$(git -C "$SOURCE_DIR" show "$sha:package.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')"
  release="$RELEASES_DIR/v$version-${sha:0:12}"
  if [ -f "$release/dist/cli.js" ] && [ "$(cat "$release/SOURCE_COMMIT" 2>/dev/null)" = "$sha" ]; then
    log "release already built: $release" >&2
  else
    log "building $REF ($sha) into $release" >&2
    rm -rf "$release" && mkdir -p "$release"
    git -C "$SOURCE_DIR" archive "$sha" | tar -x -C "$release"
    echo "$sha" > "$release/SOURCE_COMMIT"
    (
      cd "$release"
      ensure_pnpm
      pnpm install --frozen-lockfile >"$release/.deploy-install.log" 2>&1 \
        || die "pnpm install failed, see $release/.deploy-install.log"
      pnpm build >"$release/.deploy-build.log" 2>&1 \
        || die "build failed, see $release/.deploy-build.log"
    ) >&2
    [ -f "$release/dist/cli.js" ] || die "build produced no dist/cli.js"
  fi
  (cd "$release" && node --input-type=module -e "import {loadConfig} from './dist/config.js'; loadConfig()") \
    || die "the new release cannot load the current config"
  echo "$release"
}

# ---------- main ----------

SERVICE_FILE="$(service_file)"
[ -n "$SERVICE_FILE" ] && [ -f "$SERVICE_FILE" ] || die "no DevSpace user service found"

case "$MODE" in
  build)
    build_release
    ;;
  deploy)
    RELEASE="$(build_release)"
    activate "$RELEASE"
    log "deployed $RELEASE"
    ;;
  rollback)
    TARGET="${ROLLBACK_TO:-$(cat "$STATE_DIR/previous" 2>/dev/null || true)}"
    [ -n "$TARGET" ] || die "no previous release recorded; pass --to DIR"
    [ -f "$TARGET/dist/cli.js" ] || die "$TARGET has no dist/cli.js"
    activate "$TARGET"
    log "rolled back to $TARGET"
    ;;
esac
