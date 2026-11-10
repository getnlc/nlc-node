'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const checkedRoots = ['lib/nlc-node', 'scripts/nlc-node', 'installer/nlc-node'];
const forbiddenTerms = ['nlc' + '-video', 'elec' + 'tron', 'p' + 'm2'];
const forbiddenImports = [
  /require\(['"](?:\.\.\/)*mcp-gateway\//,
  /require\(['"](?:\.\.\/)*ui\//,
  ...forbiddenTerms.map((term) => new RegExp(term, 'i')),
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}

function verifyBoundaries(root = projectRoot) {
  const violations = [];
  for (const relativeRoot of checkedRoots) {
    const absoluteRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const filePath of walk(absoluteRoot)) {
      if (!/\.(?:cjs|js|json|ps1|nsi|swift|sh|cpp|plist)$/.test(filePath)) continue;
      const source = fs.readFileSync(filePath, 'utf8');
      for (const pattern of forbiddenImports) {
        if (pattern.test(source)) violations.push(`${path.relative(root, filePath)} matches ${pattern}`);
      }
    }
  }
  if (violations.length) throw new Error(`NLC Node boundary violation: ${violations.join('; ')}`);
  verifyCandidatePaths(root);
  return true;
}

function verifyCandidatePaths(root = projectRoot) {
  const output = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  const allowedRoots = ['features/nlc-node/', 'installer/nlc-node/', 'lib/nlc-node/', 'scripts/nlc-node/', 'tests/nlc-node/'];
  const allowedFiles = [
    '.github/workflows/nlc-node-windows.yml',
    '.github/workflows/nlc-node-macos.yml',
    '.github/workflows/nlc-node-ffmpeg.yml',
    '.github/workflows/nlc-node-whisper.yml',
    'mcp-gateway/nlc-central-capability-provider.cjs',
    'mcp-gateway/nlc-central-mcp-catalogue.cjs',
    'mcp-gateway/nlc-central-public.cjs',
    'mcp-gateway/nlc-central-server.cjs',
    'tests/nlc-central-runtime-event.test.mjs',
  ];
  const violations = output.split('\n').filter(Boolean).map((line) => line.slice(3).trim()).filter((candidate) => {
    const target = candidate.includes(' -> ') ? candidate.split(' -> ').pop() : candidate;
    return target !== 'package.json'
      && target !== 'package-lock.json'
      && !allowedFiles.includes(target)
      && !allowedRoots.some((rootPath) => target.startsWith(rootPath));
  });
  if (violations.length) throw new Error(`NLC Node candidate has out-of-scope paths: ${violations.join(', ')}`);
  return true;
}

if (require.main === module) {
  try {
    verifyBoundaries();
    process.stdout.write('NLC Node boundary verification passed.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyBoundaries, verifyCandidatePaths };
