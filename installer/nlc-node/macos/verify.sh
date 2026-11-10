#!/usr/bin/env bash
# Verifies a built NLC Node dmg on a throw-away macOS runner (checks I02, I04, C06 and the macOS side of I01).
#   verify.sh /path/to/NLC-Node.dmg [--require-trust] [--structure-only]
# --structure-only: for the other architecture on a runner that cannot run it (reports what it could not run).
# It starts and stops the Node under the current user's account, so it refuses to run outside CI (set CI=true on purpose to override).
set -euo pipefail

DMG_PATH=${1:?Usage: verify.sh /path/to/NLC-Node.dmg [--require-trust] [--structure-only]}
shift || true
REQUIRE_TRUST=0
STRUCTURE_ONLY=0
for argument in "$@"; do
  case "${argument}" in
    --require-trust) REQUIRE_TRUST=1 ;;
    --structure-only) STRUCTURE_ONLY=1 ;;
    *) echo "Unknown option ${argument}" >&2; exit 1 ;;
  esac
done
if [[ -z "${CI:-}" ]]; then
  echo "NLC Node verify.sh starts the Node as the current user. Run it on a CI runner, or set CI=true on purpose." >&2
  exit 1
fi
if [[ ! -f "${DMG_PATH}" ]]; then
  echo "NLC Node installer is missing: ${DMG_PATH}" >&2
  exit 1
fi
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HEALTH="${SCRIPT_DIR}/../../../scripts/nlc-node/loopback-health.cjs"
STATE_ROOT="${HOME}/Library/Application Support/NLC Node"
WORK=$(mktemp -d)
MOUNT="${WORK}/mount"
INSTALL_ROOT="${WORK}/Applications"
mkdir -p "${MOUNT}" "${INSTALL_ROOT}"

if [[ "${REQUIRE_TRUST}" == "1" ]]; then
  xcrun stapler validate "${DMG_PATH}"
  spctl -a -vv --type open --context context:primary-signature "${DMG_PATH}"
fi

# Open the dmg the way a customer does and copy the app out (the Applications drag, without needing administrator rights).
hdiutil attach -nobrowse -readonly -mountpoint "${MOUNT}" "${DMG_PATH}"
cp -R "${MOUNT}/NLC Node.app" "${INSTALL_ROOT}/"
hdiutil detach "${MOUNT}"
APP_PATH="${INSTALL_ROOT}/NLC Node.app"
LAUNCHER_PATH="${APP_PATH}/Contents/MacOS/NLC Node"
HOST_PATH="${APP_PATH}/Contents/MacOS/NLC Node Host"
[[ -x "${LAUNCHER_PATH}" ]] || { echo "NLC Node launcher was not in the dmg." >&2; exit 1; }
[[ -x "${HOST_PATH}" ]] || { echo "NLC Node host was not in the dmg." >&2; exit 1; }
# Menu-bar app: it must not appear in the Dock.
[[ "$(/usr/bin/plutil -extract LSUIElement raw "${APP_PATH}/Contents/Info.plist")" == "true" ]] || { echo "NLC Node must be a menu-bar app (LSUIElement)." >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
if [[ "${REQUIRE_TRUST}" == "1" ]]; then
  spctl --assess --type execute -vv "${APP_PATH}"
fi
ARCHS=$(lipo -archs "${HOST_PATH}")
echo "NLC Node host architectures: ${ARCHS}"

if [[ "${STRUCTURE_ONLY}" == "1" ]]; then
  echo "NLC Node structure checks passed for ${ARCHS}. NOT RUN on this machine: launch, health, single instance, launch at login."
  exit 0
fi

# Customer files that must survive removing the app.
SENTINEL_ID=$(uuidgen | tr -d '-')
TRASH_ROOT="${HOME}/NLC Trash"
TRASH_EXISTED=0; [[ -d "${TRASH_ROOT}" ]] && TRASH_EXISTED=1
FOLDER_ROOT="${HOME}/Documents/NLC-Node-Verify-${SENTINEL_ID}"
mkdir -p "${TRASH_ROOT}" "${FOLDER_ROOT}"
printf 'trash %s' "${SENTINEL_ID}" > "${TRASH_ROOT}/verify-sentinel-${SENTINEL_ID}.txt"
printf 'folder %s' "${SENTINEL_ID}" > "${FOLDER_ROOT}/clip.txt"

wait_for_file_text() { # file expected seconds
  local deadline=$((SECONDS + $3))
  while (( SECONDS < deadline )); do
    if [[ -f "$1" && "$(cat "$1")" == "$2" ]]; then return 0; fi
    sleep 0.25
  done
  echo "NLC Node: $1 did not become '$2'." >&2
  return 1
}

# I02: the unsigned app launches and answers a loopback health call.
"${LAUNCHER_PATH}" --verify
node "${HEALTH}" --timeout-ms 30000

# Start the way the LaunchAgent does: quiet, resident menu-bar app.
"${LAUNCHER_PATH}" --background &
TRAY_PID=$!
wait_for_file_text "${STATE_ROOT}/tray.txt" "offline" 20
HOST_PID_BEFORE=$(node -e "process.stdout.write(String(require('${STATE_ROOT}/ready.json').pid))")
printf '{"state":"connected"}\n' > "${STATE_ROOT}/indicator.json"
wait_for_file_text "${STATE_ROOT}/tray.txt" "connected" 10
printf '{"state":"paused"}\n' > "${STATE_ROOT}/indicator.json"
wait_for_file_text "${STATE_ROOT}/tray.txt" "paused" 10

# I04: a second launch shows the existing window and starts nothing new.
rm -f "${STATE_ROOT}/last-open.txt"
"${LAUNCHER_PATH}" --verify
PORT=$(node -e "process.stdout.write(String(require('${STATE_ROOT}/endpoint.json').port))")
[[ "$(cat "${STATE_ROOT}/last-open.txt")" == "http://127.0.0.1:${PORT}/" ]] || { echo "NLC Node second launch did not point at the existing window." >&2; exit 1; }
"${LAUNCHER_PATH}" --background
[[ "$(node -e "process.stdout.write(String(require('${STATE_ROOT}/ready.json').pid))")" == "${HOST_PID_BEFORE}" ]] || { echo "NLC Node second launch started a second host." >&2; exit 1; }
[[ "$(pgrep -x 'NLC Node' | wc -l | tr -d ' ')" == "1" ]] || { echo "NLC Node has more than one menu-bar app after a second launch." >&2; exit 1; }
[[ "$(pgrep -x 'NLC Node Host' | wc -l | tr -d ' ')" == "1" ]] || { echo "NLC Node has more than one host after a second launch." >&2; exit 1; }

# C06 (as far as a runner can): the LaunchAgent exists and is correct; stop everything, then start exactly what it starts at login.
AGENT="${HOME}/Library/LaunchAgents/com.nlc.node.plist"
/usr/bin/plutil -lint "${AGENT}"
[[ "$(/usr/bin/plutil -extract RunAtLoad raw "${AGENT}")" == "true" ]] || { echo "NLC Node LaunchAgent does not run at login." >&2; exit 1; }
AGENT_EXECUTABLE=$(/usr/bin/plutil -extract ProgramArguments.0 raw "${AGENT}")
AGENT_ARGUMENT=$(/usr/bin/plutil -extract ProgramArguments.1 raw "${AGENT}")
[[ "${AGENT_EXECUTABLE}" == "${LAUNCHER_PATH}" ]] || { echo "NLC Node LaunchAgent does not point at the app." >&2; exit 1; }
[[ "${AGENT_ARGUMENT}" == "--background" ]] || { echo "NLC Node LaunchAgent must start quietly." >&2; exit 1; }
"${HOST_PATH}" --stop
kill "${TRAY_PID}" 2>/dev/null || true
node "${HEALTH}" --expect down --timeout-ms 20000
"${AGENT_EXECUTABLE}" "${AGENT_ARGUMENT}" &
TRAY_PID=$!
node "${HEALTH}" --timeout-ms 30000
HOST_PID_AFTER=$(node -e "process.stdout.write(String(require('${STATE_ROOT}/ready.json').pid))")
[[ "${HOST_PID_AFTER}" != "${HOST_PID_BEFORE}" ]] || { echo "NLC Node did not start by itself from its login entry." >&2; exit 1; }
rm -f "${STATE_ROOT}/indicator.json"

# Removal: stop, remove the login entry and the app. Customer files and NLC Trash stay.
"${HOST_PATH}" --stop
kill "${TRAY_PID}" 2>/dev/null || true
node "${HEALTH}" --expect down --timeout-ms 20000
"${LAUNCHER_PATH}" --uninstall-login
[[ ! -e "${AGENT}" ]] || { echo "NLC Node LaunchAgent remains after removal." >&2; exit 1; }
rm -f "${STATE_ROOT}/ready.json" "${STATE_ROOT}/user-stopped.json" "${STATE_ROOT}/instance.lock" "${STATE_ROOT}/stop.request" "${STATE_ROOT}/token" "${STATE_ROOT}/endpoint.json" "${STATE_ROOT}/indicator.json" "${STATE_ROOT}/tray.txt" "${STATE_ROOT}/last-open.txt"
rmdir "${STATE_ROOT}" 2>/dev/null || true
[[ ! -e "${STATE_ROOT}" ]] || { echo "NLC Node state remains after removal." >&2; exit 1; }
rm -rf "${APP_PATH}"
[[ ! -e "${APP_PATH}" ]] || { echo "NLC Node application remains after removal." >&2; exit 1; }
[[ "$(cat "${TRASH_ROOT}/verify-sentinel-${SENTINEL_ID}.txt")" == "trash ${SENTINEL_ID}" ]] || { echo "NLC Trash content changed or vanished." >&2; exit 1; }
[[ "$(cat "${FOLDER_ROOT}/clip.txt")" == "folder ${SENTINEL_ID}" ]] || { echo "A customer folder changed or vanished." >&2; exit 1; }
rm -f "${TRASH_ROOT}/verify-sentinel-${SENTINEL_ID}.txt" "${FOLDER_ROOT}/clip.txt"
rmdir "${FOLDER_ROOT}"
if [[ "${TRASH_EXISTED}" == "0" ]]; then rmdir "${TRASH_ROOT}"; fi
echo "NLC Node macOS dmg, launch, single-instance, login-entry and removal verification passed (${ARCHS})."
