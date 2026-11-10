'use strict';
// One command that refreshes github.com/getnlc/nlc-node from a release's source and its checksum folders:
//   node scripts/nlc-node/publish-public-source.cjs --source-root <release checkout> --downloads <folder of per-build checksum folders> [--version <x>]
// It is the same refresh publishVerifiedRelease runs after a release is published (publish-release.cjs); this entry exists for
// the release steps that place a Node build without that function. The only thing it needs from outside is the repository's
// write deploy key file, pushed over SSH (default ~/.ssh/getnlc-nlc-node-deploy, or the file named by NLC_NODE_PUBLIC_SOURCE_KEY).
const { refreshPublicSource } = require('./publish-release.cjs');
const { githubPublicSourceAdapter } = require('./public-source-github.cjs');

const REPOSITORY = 'https://github.com/getnlc/nlc-node';

async function main(argv = process.argv.slice(2), environment = process.env) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
  const sourceRoot = get('--source-root');
  if (!sourceRoot) throw new Error('--source-root <release checkout> is needed.');
  const result = await refreshPublicSource({
    publicSource: { sourceRoot, downloads: get('--downloads'), sourceUrl: REPOSITORY, adapterProvider: async () => githubPublicSourceAdapter({ repository: REPOSITORY, environment }) },
    manifest: { version: get('--version') },
  });
  return result;
}

if (require.main === module) {
  main().then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok) process.exitCode = 1; })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { main, REPOSITORY };
