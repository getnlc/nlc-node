'use strict';
// The one place that says what the build outputs are called. The builds (installer/nlc-node/*, build-payload.cjs) and the
// download route (ui/lib/node-download-routes.js) both read these names, so what CI produces is what the route serves.
const SETUP_EXE = 'NLC-Node-Setup-x64.exe';
const DMG_NAMES = Object.freeze({ 'macos-arm64': 'NLC-Node-arm64.dmg', 'macos-x64': 'NLC-Node-x64.dmg' });
const PAYLOAD_NAMES = Object.freeze({
  'macos-arm64': 'payload-macos-arm64.tar.gz',
  'macos-x64': 'payload-macos-x64.tar.gz',
  'windows-x64': 'payload-win-x64.zip',
});
// The names the web address uses for the same three payloads (a fixed list; never built from request text).
const PAYLOAD_ROUTE_NAMES = Object.freeze({
  'mac-arm64.tar.gz': PAYLOAD_NAMES['macos-arm64'],
  'mac-x64.tar.gz': PAYLOAD_NAMES['macos-x64'],
  'win-x64.zip': PAYLOAD_NAMES['windows-x64'],
});
function dmgName(target) {
  if (!DMG_NAMES[target]) throw new Error('NLC Node dmg files exist for macos-arm64 and macos-x64.');
  return DMG_NAMES[target];
}
module.exports = { SETUP_EXE, DMG_NAMES, PAYLOAD_NAMES, PAYLOAD_ROUTE_NAMES, dmgName };

if (require.main === module) {
  // Used by shell build scripts:  node lib/nlc-node/artifact-names.cjs dmg macos-arm64
  const [kind, target] = process.argv.slice(2);
  try {
    if (kind === 'dmg') process.stdout.write(`${dmgName(target)}\n`);
    else if (kind === 'setup') process.stdout.write(`${SETUP_EXE}\n`);
    else throw new Error('Usage: artifact-names.cjs dmg <macos-arm64|macos-x64> | setup');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
