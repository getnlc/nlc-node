#!/bin/sh
# NLC Node installer for Mac. Run it with:  curl -fsSL __NLC_ORIGIN__/downloads/nlc-node/install.sh | sh
# It installs for your user only (no password, no administrator rights), starts NLC Node and opens its window.
# Remove it again with:  curl -fsSL __NLC_ORIGIN__/downloads/nlc-node/install.sh | sh -s -- --uninstall
# Your own folders and the NLC Trash folder are never touched.

ORIGIN='__NLC_ORIGIN__'
LINK_DEFAULT='__NLC_LINK__'
LABEL='com.nlc.node'

say() { printf '%s\n' "$*"; }
fail() { printf '\nNLC Node could not be installed: %s\n' "$*" >&2; exit 1; }

main() {
  UNINSTALL=0
  for arg in "$@"; do
    case "$arg" in --uninstall) UNINSTALL=1 ;; esac
  done
  [ "${NLC_NODE_UNINSTALL:-}" = "1" ] && UNINSTALL=1

  # NLC_NODE_FORCE_MAC / NLC_NODE_FORCE_ARCH exist only so the installer can be rehearsed on a Linux test machine.
  if [ "${NLC_NODE_FORCE_MAC:-}" != "1" ] && [ "$(uname -s)" != "Darwin" ]; then
    fail "this installer is for a Mac. On Windows, open PowerShell and use the Windows line from your NLC dashboard."
  fi
  ARCH_RAW="${NLC_NODE_FORCE_ARCH:-$(uname -m)}"
  case "$ARCH_RAW" in
    arm64|aarch64) KIND='mac-arm64' ;;
    x86_64|amd64)
      KIND='mac-x64'
      # A Terminal running under Rosetta reports Intel on an Apple-chip Mac; trust the hardware.
      if [ -z "${NLC_NODE_FORCE_ARCH:-}" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then KIND='mac-arm64'; fi ;;
    *) fail "this Mac's chip ($ARCH_RAW) is not supported." ;;
  esac

  [ -n "${HOME:-}" ] || fail "no home folder was found."
  BASE="$HOME/Library/Application Support/NLC Node"
  APP_DIR="$BASE/app"
  APP="$APP_DIR/NLC Node.app"
  HOST_BIN="$APP/Contents/MacOS/NLC Node Host"
  LAUNCHER="$APP/Contents/MacOS/NLC Node"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  UID_NUM="$(id -u)"

  if [ "$UNINSTALL" = "1" ]; then
    say "Removing NLC Node from this Mac..."
    # Take the restart supervisor away first, or it would start NLC Node again right after it is stopped.
    [ -x "$HOST_BIN" ] && "$HOST_BIN" --remove-supervision >/dev/null 2>&1
    [ -x "$HOST_BIN" ] && "$HOST_BIN" --stop >/dev/null 2>&1
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1
      launchctl unload "$PLIST" >/dev/null 2>&1
    fi
    rm -f "$PLIST"
    case "$BASE" in */"Application Support/NLC Node") rm -rf "$BASE" ;; esac
    say "NLC Node is removed. Your folders and the NLC Trash folder were left exactly as they were."
    return 0
  fi

  say "Installing NLC Node for this Mac (no password needed)..."
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/nlc-node.XXXXXX")" || fail "could not make a temporary folder."
  trap 'rm -rf "$TMP"' EXIT

  say "1/5  Downloading NLC Node..."
  curl -fsSL "$ORIGIN/downloads/nlc-node/payload/$KIND.tar.gz" -o "$TMP/payload.tar.gz" || fail "the download did not work. NLC may still be preparing it; please try again in a few minutes."
  curl -fsSL "$ORIGIN/downloads/nlc-node/payload/$KIND.tar.gz.sha256" -o "$TMP/payload.sha256" || fail "the download check file did not arrive. Please try again."
  WANT="$(awk '{print $1; exit}' "$TMP/payload.sha256")"
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP/payload.tar.gz" | awk '{print $1}')"; else GOT="$(sha256sum "$TMP/payload.tar.gz" | awk '{print $1}')"; fi
  [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || fail "the download is damaged (its check did not match). Nothing was installed. Please try again."
  # A self-update names the build the server announced; anything else is refused.
  [ -z "${NLC_NODE_EXPECT_SHA:-}" ] || [ "$NLC_NODE_EXPECT_SHA" = "$WANT" ] || fail "the published build is not the one that was announced. Nothing was installed."

  say "2/5  Putting it in place..."
  mkdir -p "$TMP/unpacked" && tar -xzf "$TMP/payload.tar.gz" -C "$TMP/unpacked" || fail "the download could not be unpacked."
  [ -d "$TMP/unpacked/NLC Node.app" ] || fail "the download did not hold NLC Node."
  # An older copy stops first, so this is also how NLC Node is updated.
  [ -x "$HOST_BIN" ] && "$HOST_BIN" --stop >/dev/null 2>&1
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1
  fi
  mkdir -p "$APP_DIR" || fail "could not make the NLC Node folder."
  chmod 700 "$BASE" 2>/dev/null
  rm -rf "$APP"
  mv "$TMP/unpacked/NLC Node.app" "$APP" || fail "could not place NLC Node."
  chmod +x "$HOST_BIN" "$LAUNCHER" 2>/dev/null
  # Files fetched with curl carry no download flag; remove one anyway if something added it.
  command -v xattr >/dev/null 2>&1 && xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1
  if command -v codesign >/dev/null 2>&1; then
    if ! codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
      codesign --force --sign - "$HOST_BIN" >/dev/null 2>&1
      codesign --force --sign - "$LAUNCHER" >/dev/null 2>&1
      codesign --force --sign - "$APP" >/dev/null 2>&1
    fi
  fi
  printf '%s\n' "$ORIGIN" > "$BASE/origin.txt"
  # The build now in place (the payload's checksum): the Node reports it, and the server only announces a build that differs.
  printf '%s\n' "$WANT" > "$BASE/installed-build.txt"

  say "3/5  Setting it to start when you log in..."
  if command -v launchctl >/dev/null 2>&1; then
    mkdir -p "$HOME/Library/LaunchAgents"
    LAUNCHER_XML="$(printf '%s' "$LAUNCHER" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g')"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$LAUNCHER_XML</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLISTEOF
  fi
  say "     Setting it to start again by itself if it ever stops..."
  "$HOST_BIN" --install-supervision >/dev/null 2>&1 || say "     (It will still start when you log in.)"

  say "4/5  Starting NLC Node..."
  STARTED=0
  if command -v launchctl >/dev/null 2>&1; then
    if launchctl bootstrap "gui/$UID_NUM" "$PLIST" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1; then STARTED=1; fi
  fi
  if [ "$STARTED" = "1" ] && wait_ready 20; then
    :
  else
    # No desktop session to start it in (for example over a remote login): start it directly.
    nohup "$HOST_BIN" --launch-id "install-$$" >/dev/null 2>&1 &
    wait_ready 25 || fail "NLC Node did not start. Please run the same line again; if it still fails, tell your assistant."
  fi
  PORT="$(sed -n 's/.*"port"[ ]*:[ ]*\([0-9][0-9]*\).*/\1/p' "$BASE/endpoint.json" 2>/dev/null | head -n 1)"
  [ -n "$PORT" ] || fail "NLC Node started but did not say where its window is."

  LINK="${NLC_NODE_LINK:-$LINK_DEFAULT}"
  PAIRED_NOW=0
  if [ -n "$LINK" ] && [ ! -f "$BASE/node-token.bin" ] && [ -f "$BASE/token" ]; then
    case "$LINK" in *[!A-Za-z0-9:/._-]*) LINK="" ;; esac
  fi
  if [ -n "$LINK" ] && [ ! -f "$BASE/node-token.bin" ] && [ -f "$BASE/token" ]; then
    say "     Connecting this Mac to your assistant..."
    ANSWER="$(curl -fsS -X POST -H "Authorization: Bearer $(cat "$BASE/token")" -H 'Content-Type: application/json' -d "{\"code\":\"$LINK\"}" "http://127.0.0.1:$PORT/v1/window/pair" 2>/dev/null)"
    case "$ANSWER" in *'"ok":true'*) PAIRED_NOW=1; say "     Connected." ;; *) say "     The link did not work (it may have expired). Enter a fresh code in the NLC Node window instead." ;; esac
  fi

  say "5/5  Done."
  if [ "${NLC_NODE_NO_OPEN:-}" != "1" ] && [ "$PAIRED_NOW" = "0" ] && command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
    say ""
    say "The NLC Node window is open. Type the code (or paste the link) your assistant gave you, then click Connect."
  fi
  say ""
  say "NLC Node is installed and running. It starts by itself when you log in."
  say "If your Mac asks whether NLC Node may run, choose Allow or Open. To remove it later, run the same line again with  | sh -s -- --uninstall"
}

# Waits until NLC Node says it is ready and its process is alive.
wait_ready() {
  _n=0
  while [ "$_n" -lt "$1" ]; do
    if [ -f "$BASE/ready.json" ] && grep -q '"state":"ready"' "$BASE/ready.json" 2>/dev/null; then
      _pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$BASE/ready.json" | head -n 1)"
      if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then return 0; fi
    fi
    sleep 1
    _n=$((_n + 1))
  done
  return 1
}

# Everything runs from one function, with nothing on its input, so a child program can never swallow the rest of a piped script.
main "$@" </dev/null
