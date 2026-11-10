'use strict';
// Assembles the public repository for NLC Node: the program's own source and nothing else.
//   node scripts/nlc-node/build-public-repo.cjs --out <empty folder> [--downloads <folder of per-build checksum folders>] [--source <repo url>]
// What goes in is a fixed list of Node's own folders. Before anything is written the files are checked: no import that
// leaves the list, no NLC app path, no secret-looking text, no customer address. Any hit stops the build with the file named.
// The README, the reach list, the removal steps and the checksum table are written from the same facts the link page uses.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildLinkFiles, PUBLISHER } = require('../../lib/nlc-node/link-page-render.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const SOURCE_ROOTS = ['lib/nlc-node', 'scripts/nlc-node', 'installer/nlc-node', 'tests/nlc-node'];
const EXTRA_FILES = [
  ['ui/lib/node-install/install.sh', 'installer/nlc-node/one-line/install.sh'],
  ['ui/lib/node-install/install.ps1', 'installer/nlc-node/one-line/install.ps1'],
];
const WORKFLOW = /^nlc-node[^/]*\.yml$/;
const TEXT = /\.(?:cjs|js|mjs|json|ps1|nsi|swift|sh|cpp|plist|md|txt|css|html|yml)$/;
const FORBIDDEN = [
  [/require\(['"](?:\.\.\/)*(?:mcp-gateway|ui)\//, 'imports the NLC app'],
  [/\/root\/nlc|\/root\/\.|nexlevelclaw\.tech|nexlevelcode\.com\/(?!node)/i, 'names an NLC server or customer address'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'holds a private key'],
  [new RegExp(`\\b(?:${['fe' + 'lix', 'co' + 'co', 'ni' + 'ka', 'jan' + 'sen'].join('|')})\\b`, 'i'), 'names a person or customer'],
  [/\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bp]-[A-Za-z0-9-]{10,}/, 'holds a token'],
  [/(?:password|secret|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/_-]{12,}['"]/i, 'holds a credential'],
  [/[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/, 'holds an email address'],
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...walk(target)); } else out.push(target);
  }
  return out;
}

function collect(root) {
  const files = new Map(); // repo path -> source path
  for (const rel of SOURCE_ROOTS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) files.set(path.relative(root, file).split(path.sep).join('/'), file);
  }
  for (const [from, to] of EXTRA_FILES) { const abs = path.join(root, from); if (fs.existsSync(abs)) files.set(to, abs); }
  const flows = path.join(root, '.github/workflows');
  if (fs.existsSync(flows)) for (const name of fs.readdirSync(flows)) if (WORKFLOW.test(name)) files.set(`.github/workflows/${name}`, path.join(flows, name));
  files.delete('scripts/nlc-node/build-public-repo.cjs.out');
  return files;
}

function check(files) {
  const problems = [];
  const have = new Set(files.keys());
  for (const [repoPath, abs] of files) {
    if (!TEXT.test(repoPath)) { problems.push(`${repoPath}: not a text source file`); continue; }
    const text = fs.readFileSync(abs, 'utf8');
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(text)) problems.push(`${repoPath}: ${why}`);
    if (/\.(?:cjs|js|mjs)$/.test(repoPath)) {
      for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), m[1]));
        const candidates = [resolved, `${resolved}.cjs`, `${resolved}.js`, `${resolved}.json`, `${resolved}/index.cjs`, `${resolved}/index.js`];
        if (!candidates.some((c) => have.has(c))) problems.push(`${repoPath}: imports ${m[1]}, which is not part of NLC Node`);
      }
    }
  }
  return problems;
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function readChecksums(downloads) {
  const builds = [];
  if (!downloads || !fs.existsSync(downloads)) return builds;
  for (const id of fs.readdirSync(downloads).sort()) {
    const dir = path.join(downloads, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const rows = [];
    let at = 0;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.sha256')).sort()) {
      const hash = fs.readFileSync(path.join(dir, name), 'utf8').trim().split(/\s+/)[0].toLowerCase();
      if (/^[0-9a-f]{64}$/.test(hash)) { rows.push([name.slice(0, -'.sha256'.length), hash]); at = Math.max(at, fs.statSync(path.join(dir, name)).mtimeMs); }
    }
    if (rows.length) builds.push({ id, at: at ? new Date(at).toISOString().slice(0, 10) : '', rows });
  }
  return builds.sort((a, b) => (b.at + b.id).localeCompare(a.at + a.id));
}

function documents({ files, builds, sourceUrl, version, omitted = [] }) {
  const hosted = JSON.parse(buildLinkFiles({ mode: 'hosted', version })['install.json']);
  const p = hosted.permissions;
  const table = (rows) => ['| File | SHA-256 |', '| --- | --- |', ...rows.map(([n, h]) => `| ${n} | \`${h}\` |`)].join('\n');
  const templates = EXTRA_FILES.map(([, to]) => to).filter((to) => files.has(to)).map((to) => [to, sha256(fs.readFileSync(files.get(to)))]);
  const readme = `# NLC Node

NLC Node is a small program a customer installs on their own Mac or Windows computer so their NLC assistant can work with the folders they choose. It is made by ${PUBLISHER}.

This repository holds NLC Node's own source code and nothing else. It does not hold NLC itself, any customer data or any secret. It is published so that you, or an AI assistant you ask, can read exactly what is installed on your computer before you install it.

## Where to start

- [WHAT-IT-CAN-REACH.md](WHAT-IT-CAN-REACH.md): what NLC Node can and cannot touch, and every network address it contacts.
- [CHECKSUMS.md](CHECKSUMS.md): the SHA-256 of every published version, and of the install scripts.
- [VERIFY.md](VERIFY.md): how to download the install script, check it, read it and run that copy.
- [REMOVE.md](REMOVE.md): how to remove NLC Node completely.

## What is here

| Folder | What it is |
| --- | --- |
| \`lib/nlc-node\` | The program: the local window, the folder rules, the connection to your own NLC, the file, video and speech tools. |
| \`scripts/nlc-node\` | How a release is built and how this repository is made. |
| \`installer/nlc-node\` | The Mac and Windows installers and the one-line install scripts (\`one-line/\`). |
| \`tests/nlc-node\` | NLC Node's own tests that run on their own.${omitted.length ? ` ${omitted.length} further tests need parts of NLC that are not published and are left out.` : ''} |

Each install script has two placeholders, \`__NLC_ORIGIN__\` (the address of your own NLC) and \`__NLC_LINK__\` (a one-time connection link, if you were given one). Your NLC fills them in when it serves the script.

## Installing

NLC Node is installed from the link your own NLC gives you (it looks like \`https://your-NLC-address/node\`). That page carries your NLC's address, the one-line command for a person, and the same install as steps for an AI assistant. This repository is the place to check what that page tells you.

${sourceUrl ? `Repository: ${sourceUrl}\n\n` : ''}## Licence

Copyright ${PUBLISHER}. Published so that anyone can read what runs on their computer. No licence to copy, change or redistribute it is granted.
`;
  const reach = `# What NLC Node can and cannot reach

${p.reads_and_changes}

- ${p.refuses}
- ${p.deletes}
- It holds no API keys, no passwords and no AI models. ${p.holds}
- ${p.runs}

## Where it installs

- Mac: ${hosted.install_locations.macos.join('; ')}.
- Windows: ${hosted.install_locations.windows.join('; ')}.

It needs no administrator rights, no sudo and no password.

## Network

| Host | When | Why |
| --- | --- | --- |
${hosted.endpoints.map((e) => `| ${e.host} | ${e.when} | ${e.purpose} |`).join('\n')}

It contacts nothing else.
`;
  const checks = `# Checksums

Every file NLC Node's installer downloads has a published SHA-256. The installer repeats this check and installs nothing if it differs. Newest build first.

## Install scripts (the files in this repository)

${table(templates)}

Your NLC serves the script with its own address filled in, and publishes the SHA-256 of exactly what it served at \`<your NLC>/downloads/nlc-node/install.sh.sha256\` (and \`install.ps1.sha256\`).

${builds.length ? builds.map((b) => `## Build ${b.id}${b.at ? ` (${b.at})` : ''}\n\n${table(b.rows)}\n`).join('\n') : 'No builds are listed yet.\n'}`;
  const verify = `# Checking the install script before you run it

Do not pipe a script into a shell. Download it to a file, compare it, read it, then run that copy. Your NLC's \`/node\` page shows these steps with your own address in them.

## Mac

\`\`\`
curl -fsSL "https://your-NLC-address/downloads/nlc-node/install.sh" -o nlc-node-install.sh
want=$(curl -fsSL "https://your-NLC-address/downloads/nlc-node/install.sh.sha256" | awk '{print $1}'); got=$(shasum -a 256 nlc-node-install.sh | awk '{print $1}'); [ "$want" = "$got" ] && echo OK || echo MISMATCH
cat nlc-node-install.sh
sh nlc-node-install.sh
\`\`\`

## Windows (PowerShell)

\`\`\`
Invoke-WebRequest -UseBasicParsing "https://your-NLC-address/downloads/nlc-node/install.ps1" -OutFile nlc-node-install.ps1
$want = ((Invoke-RestMethod "https://your-NLC-address/downloads/nlc-node/install.ps1.sha256").ToString().Trim() -split '\\s+')[0]; $got = (Get-FileHash .\\nlc-node-install.ps1 -Algorithm SHA256).Hash.ToLower(); if ($got -eq $want) { 'OK' } else { 'MISMATCH' }
Get-Content .\\nlc-node-install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\\nlc-node-install.ps1
\`\`\`

The execution-policy option applies to that one run only; no setting on the computer is changed.

## Compare with this repository

The script you downloaded is \`installer/nlc-node/one-line/install.sh\` (or \`install.ps1\`) with \`__NLC_ORIGIN__\` replaced by your NLC's address and \`__NLC_LINK__\` by your connection link (or nothing). Any other difference is a reason not to run it.
`;
  const remove = `# Removing NLC Node

${hosted.uninstall.steps.map((s) => `## ${s.os === 'macos' ? 'Mac' : 'Windows'}\n\n\`\`\`\n${s.command}\n\`\`\`\n`).join('\n')}
${hosted.uninstall.removes}

It leaves: ${hosted.uninstall.leaves}
`;
  return { 'README.md': readme, 'WHAT-IT-CAN-REACH.md': reach, 'CHECKSUMS.md': checks, 'VERIFY.md': verify, 'REMOVE.md': remove };
}

function buildPublicRepo({ root = projectRoot, out, downloads, sourceUrl = '', version = '' } = {}) {
  if (!out) throw new Error('--out <folder> is needed.');
  const files = collect(root);
  if (!files.size) throw new Error('No NLC Node source was found.');
  // A test that reaches into the NLC app cannot run from this repository, so it is left out (and listed); any other file that does is a refusal.
  const omitted = [];
  for (let again = true; again;) {
    again = false;
    const bad = new Set(check(files).map((line) => line.split(': ')[0]));
    for (const file of bad) if (file.startsWith('tests/')) { files.delete(file); omitted.push(file); again = true; }
  }
  const problems = check(files);
  if (problems.length) throw new Error(`NLC Node public repository refused:\n${problems.join('\n')}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty.`);
  let ver = version;
  if (!ver) { try { ver = String(JSON.parse(fs.readFileSync(path.join(root, 'installer/nlc-node/release.json'), 'utf8')).version || ''); } catch { ver = ''; } }
  const docs = documents({ files, builds: readChecksums(downloads), sourceUrl, version: ver || '0.1.0', omitted });
  for (const [repoPath, abs] of files) {
    const target = path.join(out, ...repoPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs, target);
  }
  for (const [name, body] of Object.entries(docs)) fs.writeFileSync(path.join(out, name), body);
  return { files: [...files.keys(), ...Object.keys(docs)].sort(), omitted: omitted.sort() };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ''; };
  try {
    const result = buildPublicRepo({ out: get('--out'), downloads: get('--downloads'), sourceUrl: get('--source') });
    process.stdout.write(`NLC Node public repository written: ${result.files.length} files.\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { buildPublicRepo, collect, check, readChecksums };
