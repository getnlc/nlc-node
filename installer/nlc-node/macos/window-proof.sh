#!/usr/bin/env bash
# Opens the built NLC Node app the way a customer does and proves the menu-bar window really opens, in light and in dark.
#   window-proof.sh <path to NLC Node dmg> <folder for the screenshots>
# Needs a Mac with a signed-in desktop (a GitHub macOS runner has one). It leaves the Mac as it found it.
set -euo pipefail

DMG_PATH=${1:?Usage: window-proof.sh <dmg> <screenshot folder>}
OUT_DIR=${2:?Usage: window-proof.sh <dmg> <screenshot folder>}
mkdir -p "${OUT_DIR}"
WORK=$(mktemp -d)
STATE_ROOT="${HOME}/Library/Application Support/NLC Node"

MOUNT=$(hdiutil attach -nobrowse -readonly "${DMG_PATH}" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -n 1)
cp -R "${MOUNT}/NLC Node.app" "${WORK}/"
hdiutil detach "${MOUNT}" -quiet || true
APP="${WORK}/NLC Node.app"
LAUNCHER="${APP}/Contents/MacOS/NLC Node"
HOST="${APP}/Contents/MacOS/NLC Node Host"
xattr -cr "${APP}" || true

end_named() { # exact process name
  local pid
  for pid in $(pgrep -x "$1" || true); do kill "${pid}" 2>/dev/null || true; done
}
stop_everything() {
  "${HOST}" --stop >/dev/null 2>&1 || true
  end_named "NLC Node"
  sleep 2
  end_named "NLC Node Host"
}
trap 'stop_everything; defaults delete -g AppleInterfaceStyle >/dev/null 2>&1 || true' EXIT

wait_for_file() { # path seconds
  local waited=0
  while [[ ! -s "$1" && ${waited} -lt $2 ]]; do sleep 1; waited=$((waited + 1)); done
  [[ -s "$1" ]]
}

prove_theme() { # light | dark
  local theme=$1
  stop_everything
  rm -f "${STATE_ROOT}/window-shown.txt" "${STATE_ROOT}/window-loaded.txt" "${STATE_ROOT}/last-open.txt"
  if [[ "${theme}" == "dark" ]]; then defaults write -g AppleInterfaceStyle Dark; else defaults delete -g AppleInterfaceStyle >/dev/null 2>&1 || true; fi
  echo "== ${theme}: appearance now '$(defaults read -g AppleInterfaceStyle 2>/dev/null || echo Light)'"

  # Start the way the LaunchAgent does: quiet, resident menu-bar app.
  "${LAUNCHER}" --background >"${OUT_DIR}/app-${theme}.log" 2>&1 &
  wait_for_file "${STATE_ROOT}/ready.json" 60 || { echo "NLC Node did not become ready (${theme})." >&2; exit 1; }
  echo "{\"state\":\"connected\"}" > "${STATE_ROOT}/indicator.json"
  sleep 4
  screencapture -x "${OUT_DIR}/mac-${theme}-1-menubar.png" || true

  # A second launch asks the running menu-bar app to show its window.
  "${LAUNCHER}"
  wait_for_file "${STATE_ROOT}/window-shown.txt" 30 || { echo "The window did not open (${theme})." >&2; exit 1; }
  grep -q "shown=true" "${STATE_ROOT}/window-shown.txt" || { echo "The popover is not showing (${theme}): $(cat "${STATE_ROOT}/window-shown.txt")" >&2; exit 1; }
  wait_for_file "${STATE_ROOT}/window-loaded.txt" 30 || { echo "The window page did not finish loading (${theme})." >&2; exit 1; }
  echo "window: $(cat "${STATE_ROOT}/window-shown.txt"); $(cat "${STATE_ROOT}/window-loaded.txt")"
  sleep 3
  screencapture -x "${OUT_DIR}/mac-${theme}-2-window.png"
  [[ -s "${OUT_DIR}/mac-${theme}-2-window.png" ]] || { echo "No screenshot (${theme})." >&2; exit 1; }
  [[ "$(pgrep -x 'NLC Node' | wc -l | tr -d ' ')" == "1" ]] || { echo "More than one NLC Node menu-bar app is running (${theme})." >&2; exit 1; }
  echo "${theme} proof ok"
}

prove_theme light
prove_theme dark
echo "NLC Node menu-bar window opened in light and dark."
