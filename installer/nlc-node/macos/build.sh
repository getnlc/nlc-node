#!/usr/bin/env bash
# Builds NLC Node.app and a dmg for one architecture.
#   build.sh macos-arm64|macos-x64 [--sign]
# macos-x64 on an arm64 Mac: set NLC_NODE_X64_NODE_BINARY to the official darwin-x64 node binary of the pinned version.
# Without --sign the app is ad-hoc signed (required for arm64 to run at all); it is NOT Developer ID signed or notarised (piece O).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../../.." && pwd)
TARGET=${1:?Usage: build.sh macos-arm64|macos-x64 [--sign]}
SIGN=${2:-}
case "${TARGET}" in
  macos-arm64) SWIFT_TARGET="arm64-apple-macos13.0" ;;
  macos-x64) SWIFT_TARGET="x86_64-apple-macos13.0" ;;
  *) echo "NLC Node builds macos-arm64 or macos-x64, not ${TARGET}." >&2; exit 1 ;;
esac
MACHINE_ARCH=$(uname -m)
if [[ "${MACHINE_ARCH}" == "x86_64" ]]; then MACHINE_ARCH="x64"; fi
CURRENT_TARGET="macos-${MACHINE_ARCH}"
SEA_EXTRA=()
if [[ "${TARGET}" != "${CURRENT_TARGET}" ]]; then
  if [[ -z "${NLC_NODE_X64_NODE_BINARY:-}" || "${TARGET}" != "macos-x64" ]]; then
    echo "NLC Node must build ${TARGET} on a matching Mac, or (macos-x64 only) with NLC_NODE_X64_NODE_BINARY set. This machine is ${CURRENT_TARGET}." >&2
    exit 1
  fi
  SEA_EXTRA=(--node-binary "${NLC_NODE_X64_NODE_BINARY}")
fi

VERSION=$(node -e "process.stdout.write(require('${REPO_ROOT}/installer/nlc-node/release.json').version)")
OUTPUT_ROOT="${REPO_ROOT}/dist/nlc-node/${TARGET}"
APP_ROOT="${OUTPUT_ROOT}/NLC Node.app"
CONTENTS="${APP_ROOT}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
STAGING="${OUTPUT_ROOT}/dmg-staging"
DMG_PATH="${OUTPUT_ROOT}/$(node "${SCRIPT_DIR}/../../../lib/nlc-node/artifact-names.cjs" dmg "${TARGET}")"
rm -rf "${OUTPUT_ROOT}"
mkdir -p "${MACOS_DIR}" "${STAGING}"

node "${REPO_ROOT}/scripts/nlc-node/build-sea.cjs" --target "${TARGET}" --output-dir "${MACOS_DIR}" "${SEA_EXTRA[@]+"${SEA_EXTRA[@]}"}"
swiftc -target "${SWIFT_TARGET}" -framework AppKit "${SCRIPT_DIR}/Launcher.swift" -o "${MACOS_DIR}/NLC Node"
sed "s/__NLC_NODE_VERSION__/${VERSION}/g" "${SCRIPT_DIR}/Info.plist" > "${CONTENTS}/Info.plist"
# build-sea leaves its bundle, blob and config next to the host; only the two executables belong in the app.
rm -f "${MACOS_DIR}/nlc-node.bundle.cjs" "${MACOS_DIR}/nlc-node.sea.blob" "${MACOS_DIR}/sea-config.json"

CENTRAL_RUNTIME=$(node -p 'process.execPath')
if [[ "${TARGET}" != "${CURRENT_TARGET}" ]]; then CENTRAL_RUNTIME="${NLC_NODE_X64_NODE_BINARY}"; fi
node "${REPO_ROOT}/scripts/nlc-node/build-payload.cjs" "${TARGET}" --stage-tools "${MACOS_DIR}" --stage-resources "${CONTENTS}/Resources" --central-runtime "${CENTRAL_RUNTIME}"

if [[ "${SIGN}" == "--sign" ]]; then
  : "${NLC_NODE_MAC_APPLICATION_IDENTITY:?NLC Node signing requires NLC_NODE_MAC_APPLICATION_IDENTITY}"
  : "${NLC_NODE_MAC_NOTARY_PROFILE:?NLC Node notarization requires NLC_NODE_MAC_NOTARY_PROFILE}"
  codesign --force --options runtime --timestamp --entitlements "${SCRIPT_DIR}/entitlements.plist" --sign "${NLC_NODE_MAC_APPLICATION_IDENTITY}" "${MACOS_DIR}/NLC Node Host"
  codesign --force --options runtime --timestamp --sign "${NLC_NODE_MAC_APPLICATION_IDENTITY}" "${MACOS_DIR}/NLC Node"
  # A test build made without the private Central package (NLC_NODE_WITHOUT_CENTRAL_TRANSPORT=1) has no central-runtime to sign.
  [[ ! -e "${MACOS_DIR}/central-runtime/node" ]] || codesign --force --options runtime --timestamp --sign "${NLC_NODE_MAC_APPLICATION_IDENTITY}" "${MACOS_DIR}/central-runtime/node"
  codesign --force --options runtime --timestamp --sign "${NLC_NODE_MAC_APPLICATION_IDENTITY}" "${APP_ROOT}"
else
  codesign --force --sign - --entitlements "${SCRIPT_DIR}/entitlements.plist" "${MACOS_DIR}/NLC Node Host"
  codesign --force --sign - "${MACOS_DIR}/NLC Node"
  [[ ! -e "${MACOS_DIR}/central-runtime/node" ]] || codesign --force --sign - "${MACOS_DIR}/central-runtime/node"
  codesign --force --sign - "${APP_ROOT}"
fi

cp -R "${APP_ROOT}" "${STAGING}/"
ln -s /Applications "${STAGING}/Applications"
hdiutil create -volname "NLC Node" -srcfolder "${STAGING}" -ov -format UDZO "${DMG_PATH}"

if [[ "${SIGN}" == "--sign" ]]; then
  codesign --force --timestamp --sign "${NLC_NODE_MAC_APPLICATION_IDENTITY}" "${DMG_PATH}"
  xcrun notarytool submit "${DMG_PATH}" --keychain-profile "${NLC_NODE_MAC_NOTARY_PROFILE}" --wait
  xcrun stapler staple "${DMG_PATH}"
  spctl -a -vv --type open --context context:primary-signature "${DMG_PATH}"
fi

printf '%s\n' "${DMG_PATH}"
