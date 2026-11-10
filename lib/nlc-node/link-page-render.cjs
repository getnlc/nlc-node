'use strict';
// The NLC Node link page: one address a customer pastes into whatever assistant runs on their computer (or reads
// themselves). This file only turns facts into three texts: index.html (people first, then the assistant section),
// llms.txt and install.json (+ the schema install.json follows). It is used by the server route (ui/lib/node-link-page.js)
// and by the static generator (scripts/nlc-node/build-link-page.cjs), so both always say the same thing.
// Every fact below comes from the code (lib/nlc-node, ui/lib/node-install, mcp/nlc-node) or from Shared Memory
// business/nlc-billing-entity. Nothing else is claimed: no registration numbers, no promises about future signing.
const fs = require('node:fs');
const path = require('node:path');

const PUBLISHER = 'FTay Consulting Sdn Bhd';
const PUBLISHER_NOTE = 'FTay Consulting Sdn Bhd is the Malaysian private limited company (Sdn Bhd) that NLC bills its customers through.';
const HOSTED_ORIGIN = 'https://nexlevelcode.com';
const HF_HOST = 'huggingface.co';
// The public home of NLC Node's own source: only NLC Node, never the rest of NLC. lib/nlc-node/public-source.json holds its
// address once the repository is published; until then the page keeps saying the source is available on request.
const SAFE_SOURCE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PUBLIC_SOURCE = (() => { try { const url = String(require('./public-source.json').url || ''); return SAFE_SOURCE.test(url) ? url : ''; } catch { return ''; } })();
const sourceSentence = (f) => (f.source
  ? `The source code of NLC Node (only NLC Node, not the rest of NLC) is public at ${f.source}. It holds the program's code, what it can and cannot reach, the checksum of every published version and how to remove it. Read it before you install.`
  : 'Source code is in a private repository and is available on request from NLC.');

const PAYLOADS = Object.freeze([
  { key: 'mac-arm64', file: 'payload-macos-arm64.tar.gz', route: 'mac-arm64.tar.gz', os: 'macos', label: 'Mac with an Apple chip' },
  { key: 'mac-x64', file: 'payload-macos-x64.tar.gz', route: 'mac-x64.tar.gz', os: 'macos', label: 'Mac with an Intel chip' },
  { key: 'win-x64', file: 'payload-win-x64.zip', route: 'win-x64.zip', os: 'windows', label: 'Windows PC' },
]);

const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const SAFE_LINK = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/n\/[A-Za-z0-9-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Reads "<hash>  <name>" files the payload builder writes. Only payloads with a valid file are listed.
function readPayloads(dir) {
  const found = {};
  for (const spec of PAYLOADS) {
    try {
      const text = fs.readFileSync(path.join(dir, `${spec.file}.sha256`), 'utf8');
      const hash = text.trim().split(/\s+/)[0].toLowerCase();
      if (HEX64.test(hash)) found[spec.key] = hash;
    } catch { /* not published yet */ }
  }
  return found;
}

// The facts shared by all three outputs.
function facts({ mode, origin, link, version, commit, sha256, source }) {
  const hosted = mode === 'hosted';
  if (!['vps', 'hosted'].includes(mode)) throw new Error('mode must be vps or hosted');
  if (!hosted && !SAFE_ORIGIN.test(origin || '')) throw new Error('A page served from an NLC address needs that address.');
  if (link && !SAFE_LINK.test(link)) throw new Error('unsafe link');
  const o = hosted ? 'https://<your-NLC-address>' : origin;
  const query = link ? `?link=${encodeURIComponent(link)}` : '';
  const hashes = sha256 || {};
  const sourceUrl = source === undefined ? PUBLIC_SOURCE : (SAFE_SOURCE.test(source || '') ? source : '');
  const available = PAYLOADS.filter((p) => hashes[p.key]);
  const ready = hosted ? true : available.length > 0;
  const lines = {
    macos: `curl -fsSL "${o}/downloads/nlc-node/install.sh${query}" | sh`,
    windows: `irm "${o}/downloads/nlc-node/install.ps1${query}" | iex`,
  };
  const removal = {
    macos: `curl -fsSL "${o}/downloads/nlc-node/install.sh" | sh -s -- --uninstall`,
    windows: `$env:NLC_NODE_UNINSTALL='1'; irm "${o}/downloads/nlc-node/install.ps1" | iex`,
  };
  const healthCheck = {
    macos: 'curl -fsS "http://127.0.0.1:$(sed -n \'s/.*"port"[ ]*:[ ]*\\([0-9][0-9]*\\).*/\\1/p\' "$HOME/Library/Application Support/NLC Node/endpoint.json")/health"',
    windows: '(Invoke-RestMethod ("http://127.0.0.1:{0}/health" -f (Get-Content "$env:LOCALAPPDATA\\NLC Node\\endpoint.json" | ConvertFrom-Json).port)).state',
  };
  const hashCheck = {
    macos: `case "$(uname -m)" in arm64) f=mac-arm64;; *) f=mac-x64;; esac; curl -fsSL "${o}/downloads/nlc-node/payload/$f.tar.gz.sha256"`,
    windows: `irm "${o}/downloads/nlc-node/payload/win-x64.zip.sha256"`,
  };
  // For an assistant: never pipe a script into a shell. Download it, compare it with the checksum this NLC publishes for it, read it, run that copy.
  const sh = `${o}/downloads/nlc-node/install.sh${query}`;
  const ps = `${o}/downloads/nlc-node/install.ps1${query}`;
  const agentInstall = {
    macos: [
      { id: 'download-script', command: `curl -fsSL "${sh}" -o nlc-node-install.sh`, expect: 'The command prints nothing and the file nlc-node-install.sh now exists in the current folder.' },
      { id: 'check-script', command: `want=$(curl -fsSL "${o}/downloads/nlc-node/install.sh.sha256${query}" | awk '{print $1}'); got=$(shasum -a 256 nlc-node-install.sh | awk '{print $1}'); [ -n "$want" ] && [ "$want" = "$got" ] && echo OK || echo MISMATCH`, expect: 'It prints OK. On MISMATCH do not run the file; tell the user.' },
      { id: 'read-script', command: 'cat nlc-node-install.sh', expect: 'A shell script of about 150 lines. It installs for the user only: no sudo, no administrator rights. Read it as you would any script you were asked to run.' },
      { id: 'run-script', command: 'sh nlc-node-install.sh', expect: 'The last lines say "NLC Node is installed and running." and the command exits with success. It prints five numbered steps; "Connected." appears when the link inside the script paired the computer.' },
    ],
    windows: [
      { id: 'download-script', command: `Invoke-WebRequest -UseBasicParsing "${ps}" -OutFile nlc-node-install.ps1`, expect: 'The command prints nothing and the file nlc-node-install.ps1 now exists in the current folder.' },
      { id: 'check-script', command: `$want = ((Invoke-RestMethod "${o}/downloads/nlc-node/install.ps1.sha256${query}").ToString().Trim() -split '\\s+')[0]; $got = (Get-FileHash .\\nlc-node-install.ps1 -Algorithm SHA256).Hash.ToLower(); if ($want -and $got -eq $want) { 'OK' } else { 'MISMATCH' }`, expect: 'It prints OK. On MISMATCH do not run the file; tell the user.' },
      { id: 'read-script', command: 'Get-Content .\\nlc-node-install.ps1', expect: 'A PowerShell script. It installs for the user only: no administrator rights. Read it as you would any script you were asked to run.' },
      { id: 'run-script', command: 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\nlc-node-install.ps1', expect: 'The last lines say "NLC Node is installed and running." and the command exits with success. The execution-policy option applies to this one run only; no setting on the computer is changed.' },
    ],
  };
  const shareFolder = {
    macos: 'S="$HOME/Library/Application Support/NLC Node"; curl -fsS -X POST "http://127.0.0.1:$(sed -n \'s/.*"port"[ ]*:[ ]*\\([0-9][0-9]*\\).*/\\1/p\' "$S/endpoint.json")/v1/window/folders/add" -H "Authorization: Bearer $(cat "$S/token")" -H \'Content-Type: application/json\' -d \'{"path":"<ABSOLUTE-FOLDER-PATH>"}\'',
    windows: '$S="$env:LOCALAPPDATA\\NLC Node"; $p=(Get-Content "$S\\endpoint.json" | ConvertFrom-Json).port; Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:{0}/v1/window/folders/add" -f $p) -Headers @{ Authorization = "Bearer $((Get-Content "$S\\token").Trim())" } -ContentType \'application/json\' -Body (@{ path = \'<ABSOLUTE-FOLDER-PATH>\' } | ConvertTo-Json) | ConvertTo-Json -Compress',
  };
  return {
    hosted, ready, shareFolder, origin: hosted ? null : origin, o, link: link || '', version, commit: commit || '', hashes, available,
    lines, removal, healthCheck, hashCheck, agentInstall, source: sourceUrl,
    pageUrl: hosted ? `${HOSTED_ORIGIN}/node` : `${origin}/node${query}`,
    installJsonUrl: hosted ? `${HOSTED_ORIGIN}/node/install.json` : `${origin}/node/install.json${query}`,
  };
}

function installJson(f) {
  const steps = [];
  for (const os of ['macos', 'windows']) {
    steps.push({ os, id: 'check-download', command: f.hashCheck[os], expect: `The first word printed equals verify.sha256 for the same file on this page (${os === 'macos' ? 'payload-macos-arm64.tar.gz or payload-macos-x64.tar.gz' : 'payload-win-x64.zip'}).` });
    for (const step of f.agentInstall[os]) steps.push({ os, ...step });
    steps.push({ os, id: 'confirm-running', command: f.healthCheck[os], expect: os === 'macos' ? '{"state":"ready"}' : 'ready' });
    steps.push({ os, id: 'share-folder', command: f.shareFolder[os], expect: 'Run once for each folder the user named, with <ABSOLUTE-FOLDER-PATH> replaced by that folder\'s full path. The answer has ok true and the folder\'s name; the same folder again is harmless. A refusal (home folder, system folder) comes back as ok false with a plain message: tell the user and ask for a different folder.' });
  }
  const sha = {};
  for (const p of PAYLOADS) if (f.hashes[p.key]) sha[p.file] = f.hashes[p.key];
  return {
    $schema: f.hosted ? `${HOSTED_ORIGIN}/node/install.schema.json` : `${f.origin}/node/install.schema.json`,
    schema_version: 1,
    name: 'NLC Node',
    publisher: { name: PUBLISHER, role: 'billing entity of NLC', note: PUBLISHER_NOTE },
    version: f.version,
    build: f.commit || 'unknown',
    one_line_for_a_person: { note: 'For a person pasting into Terminal or PowerShell. An assistant should use the steps below instead: they download the script, check it and run the reviewed copy.', macos: f.lines.macos, windows: f.lines.windows },
    summary: 'A small program the customer installs on their own computer so their NLC assistant can work with the folders they choose.',
    mode: f.hosted ? 'hosted-copy' : 'customer-nlc',
    origin: f.origin,
    status: f.ready ? 'ready' : 'preparing',
    install_link: f.pageUrl,
    os: ['macos', 'windows'],
    requires: { admin_rights: false, password: false, internet: true, disk: 'under 200 MB', accounts: 'none (no Apple or Microsoft sign-in)' },
    steps,
    verify: {
      sha256: sha,
      how: 'Download the payload from the install address, hash it with SHA-256 and compare to this table. The installer script repeats the same check against the .sha256 file served beside the payload and installs nothing if it differs.',
      source: { public: Boolean(f.source), url: f.source || null, availability: sourceSentence(f), commit: f.commit || null },
      script: { how: 'The install script is served by this NLC with its own SHA-256 (install.sh.sha256 and install.ps1.sha256 beside it, with the same link query). Download the script to a file, compare, read it, then run that file; do not pipe it into a shell.', sha256_urls: { macos: `${f.o}/downloads/nlc-node/install.sh.sha256${f.link ? '?link=' + encodeURIComponent(f.link) : ''}`, windows: `${f.o}/downloads/nlc-node/install.ps1.sha256${f.link ? '?link=' + encodeURIComponent(f.link) : ''}` } },
      success_check: { mac: f.healthCheck.macos, windows: f.healthCheck.windows, expect_state: 'ready', process: { macos: 'NLC Node Host', windows: 'NLC Node Host.exe' } },
    },
    install_locations: {
      macos: ['~/Library/Application Support/NLC Node/app/NLC Node.app', '~/Library/Application Support/NLC Node (its own settings and state)', '~/Library/LaunchAgents/com.nlc.node.plist (start at login)'],
      windows: ['%LOCALAPPDATA%\\Programs\\NLC Node (NLC Node.exe, NLC Node Host.exe)', '%LOCALAPPDATA%\\NLC Node (its own settings and state)', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run, value "NLC Node" (start at login)'],
    },
    permissions: {
      reads_and_changes: 'Only folders the user adds in the NLC Node window. Nothing else on the computer is read or changed.',
      refuses: 'The whole home folder and system folders cannot be added.',
      deletes: 'Deleting moves the item to the folder "NLC Trash" in the user\'s home folder; it can be restored. Nothing is deleted permanently.',
      holds_no: ['API keys', 'passwords', 'AI models'],
      holds: 'One connection credential for the customer\'s own NLC, stored in the program\'s own settings folder. A local list of actions (time, tool, folder, path, result; never file contents).',
      runs: 'A background program (NLC Node Host) and a small launcher. The window the user sees is a page served only on 127.0.0.1.',
    },
    endpoints: [
      { host: f.hosted ? '<the customer\'s own NLC address>' : new URL(f.origin).host, protocol: 'https (wss for the live connection)', when: 'installing, updating, and always while connected', purpose: 'Download the installer and the program; keep the live connection to the customer\'s own NLC; pair using the connection link.' },
      { host: '127.0.0.1', protocol: 'http, this computer only', when: 'always', purpose: 'The NLC Node window and its health answer. Not reachable from other computers.' },
      { host: HF_HOST, protocol: 'https', when: 'only the first time the user asks for captions from audio', purpose: 'Downloads one speech model file (about 148 MB), checked against a fixed SHA-256 before use. Nothing is uploaded.' },
      { host: '(none)', when: 'video tools (ffmpeg)', purpose: 'ffmpeg runs on the computer and makes no network calls.' },
    ],
    pairing: {
      how: 'The customer opens NLC Central, goes to Installations, and presses Download for Mac or Windows on their NLC card to get the download or this page. Nothing is copied or typed: once installed and opened, NLC Node asks the NLC it was downloaded from to connect, and the customer presses Allow in NLC Central: Installations, on their NLC card, where the computer shows wants to connect. Until then the computer is only listed as waiting.',
      without_link: 'If a link or code is already available it still works: the NLC Node window accepts a connection code or link and the computer connects without waiting for Allow.',
      code_lifetime: 'A request waits 10 minutes for the customer to press Allow; the NLC Node window offers Try again after that, or if Deny was pressed.',
      agent_action: 'Nothing to do when the link you were given carries the connection link: the install command pairs. Otherwise the computer asks its NLC to connect and waits: tell the user to press Allow in NLC Central: Installations, on their NLC card, where the computer shows wants to connect. If they already have a connection code or link, send it to this computer with POST /v1/window/pair and {"code": ...}, using the key in the NLC Node state folder, as the installer does. Do not ask for, store or forward any NLC password or key.',
    },
    uninstall: {
      steps: [{ os: 'macos', command: f.removal.macos }, { os: 'windows', command: f.removal.windows }],
      removes: 'The program, its own settings and state, the start-at-login entry.',
      leaves: 'Every file in the user\'s own folders and the NLC Trash folder, exactly as they were.',
    },
    ask_user_first: [
      'This installs software on your computer: NLC Node, made by ' + PUBLISHER + ' for your NLC. It goes in your own user folder, needs no password or administrator rights, and starts when you log in. Do you want me to go ahead?',
      'Is this the computer you want your NLC assistant to work with, and is this link from your own NLC dashboard?',
      'Which folders may your assistant use? Name each one (for example Documents/Projects). Nothing else on the computer will be shared.',
    ],
    tell_user_after: [
      'What was installed, and where (see install_locations).',
      'That it starts at login, and how to remove it (uninstall).',
      'Which folders are now shared (full paths), and that they can add or remove folders any time in the NLC Node window.',
      'Whether the computer connected ("Connected.") or is waiting for the customer to press Allow in NLC Central, Installations, on their NLC card.',
    ],
  };
}

const INSTALL_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'NLC Node install description',
  type: 'object',
  required: ['schema_version', 'name', 'publisher', 'version', 'os', 'steps', 'verify', 'permissions', 'endpoints', 'uninstall', 'pairing'],
  properties: {
    $schema: { type: 'string' },
    schema_version: { type: 'integer', enum: [1] },
    name: { type: 'string', enum: ['NLC Node'] },
    publisher: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, role: { type: 'string' }, note: { type: 'string' } } },
    version: { type: 'string', minLength: 1 },
    build: { type: 'string' },
    summary: { type: 'string' },
    mode: { type: 'string', enum: ['customer-nlc', 'hosted-copy'] },
    origin: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['ready', 'preparing'] },
    install_link: { type: 'string' },
    os: { type: 'array', minItems: 1, items: { type: 'string', enum: ['macos', 'windows'] } },
    requires: { type: 'object' },
    steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['os', 'id', 'command', 'expect'], properties: { os: { type: 'string', enum: ['macos', 'windows'] }, id: { type: 'string', enum: ['check-download', 'download-script', 'check-script', 'read-script', 'run-script', 'confirm-running', 'share-folder'] }, command: { type: 'string', minLength: 1 }, expect: { type: 'string', minLength: 1 } } } },
    verify: { type: 'object', required: ['sha256', 'how'], properties: { sha256: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, how: { type: 'string' }, source: { type: 'object' }, success_check: { type: 'object' } } },
    install_locations: { type: 'object' },
    permissions: { type: 'object', required: ['reads_and_changes', 'deletes', 'holds_no'], properties: { reads_and_changes: { type: 'string' }, deletes: { type: 'string' }, holds_no: { type: 'array', items: { type: 'string' } } } },
    endpoints: { type: 'array', minItems: 1, items: { type: 'object', required: ['host', 'purpose'], properties: { host: { type: 'string', minLength: 1 }, purpose: { type: 'string' }, when: { type: 'string' }, protocol: { type: 'string' } } } },
    pairing: { type: 'object', required: ['how'], properties: { how: { type: 'string' } } },
    uninstall: { type: 'object', required: ['steps', 'leaves'], properties: { steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['os', 'command'], properties: { os: { type: 'string' }, command: { type: 'string' } } } }, removes: { type: 'string' }, leaves: { type: 'string' } } },
    ask_user_first: { type: 'array', items: { type: 'string' } },
    tell_user_after: { type: 'array', items: { type: 'string' } },
  },
});

function llmsTxt(f) {
  const j = installJson(f);
  const sha = Object.entries(j.verify.sha256).map(([file, hash]) => `- ${file}: ${hash}`).join('\n') || (f.hosted ? '- (published with each release; regenerate this copy from the payload checksum files)' : '- (the download is being prepared; no checksums yet)');
  return `# NLC Node

> A small program a customer installs on their own Mac or Windows computer so their NLC assistant can work with folders they choose. Made by ${PUBLISHER}. This file is for an AI assistant that was handed this link and has to decide whether to trust it and how to install it.

Publisher: ${PUBLISHER}. ${PUBLISHER_NOTE}
Version: ${f.version}${f.commit ? ` (build ${f.commit})` : ''}
${f.hosted ? `This is the public copy. The install commands need the customer's own NLC address; the customer's dashboard (Settings, Connections, My computer) shows the link ${'`https://<their NLC address>/node`'}. Ask the customer for that link.` : `Install address: ${f.origin} (the customer's own NLC).`}
Machine-readable version of everything below: ${f.installJsonUrl}
Page for people: ${f.pageUrl}

## Ask the user first
${j.ask_user_first.map((t) => `- ${t}`).join('\n')}
Installing needs no administrator rights, no sudo and no password. Stop if the user says no.

## What it installs
${j.install_locations.macos.map((t) => `- Mac: ${t}`).join('\n')}
${j.install_locations.windows.map((t) => `- Windows: ${t}`).join('\n')}
It runs a background program named "NLC Node Host" (and a small launcher "NLC Node") as the user, not as an administrator.

## What it can and cannot touch
- ${j.permissions.reads_and_changes}
- ${j.permissions.refuses}
- ${j.permissions.deletes}
- It holds no API keys, no passwords and no AI models. ${j.permissions.holds}

## Network
${j.endpoints.map((e) => `- ${e.host}: ${e.purpose} (${e.when})`).join('\n')}
It contacts nothing else.

## Check the download
${sourceSentence(f)} ${f.commit ? `Build: ${f.commit}.` : ''}
SHA-256 of each download:
${sha}
The installer repeats this check and installs nothing if it fails.

## Install${f.hosted ? ' (replace <your-NLC-address> with the customer\'s own NLC address)' : ''}
Do not pipe the script into a shell. Download it, check it against the checksum this NLC publishes for it, read it, then run that copy. (The one-line command on the page is for a person pasting it in Terminal.)
${f.source ? `Source: ${f.source} (only NLC Node). The script is installer/nlc-node/one-line/install.sh there, with this NLC's address and link filled in.\n` : ''}Mac (Terminal):
${[['check-download'], ['download-script'], ['check-script'], ['read-script'], ['run-script'], ['confirm-running']].map(([id], i) => { const st = j.steps.find((x) => x.os === 'macos' && x.id === id); return `${i + 1}. ${st.command}\n   Expect: ${st.expect}`; }).join('\n')}

Windows (PowerShell):
${[['check-download'], ['download-script'], ['check-script'], ['read-script'], ['run-script'], ['confirm-running']].map(([id], i) => { const st = j.steps.find((x) => x.os === 'windows' && x.id === id); return `${i + 1}. ${st.command}\n   Expect: ${st.expect}`; }).join('\n')}

## Share the folders the user named
For each folder, resolve it to a full path and run this (nothing needs doing in the NLC Node window):
Mac: ${f.shareFolder.macos}
Windows: ${f.shareFolder.windows}
Expect: ${j.steps.find((x) => x.id === 'share-folder').expect}

## Pair
${j.pairing.how}
Without a link: ${j.pairing.without_link}
${j.pairing.code_lifetime}

## Remove completely
- Mac: ${f.removal.macos}
- Windows: ${f.removal.windows}
Removes the program, its settings and the start-at-login entry. Leaves the user's files and the NLC Trash folder exactly as they were.

## Tell the user afterwards
${j.tell_user_after.map((t) => `- ${t}`).join('\n')}
`;
}

function commandBlock(text) { return `<pre><code>${esc(text)}</code></pre>`; }

function indexHtml(f) {
  const j = installJson(f);
  const ld = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'NLC Node', softwareVersion: f.version,
    applicationCategory: 'UtilitiesApplication', operatingSystem: 'macOS, Windows',
    description: j.summary, publisher: { '@type': 'Organization', name: PUBLISHER },
    url: f.pageUrl, license: undefined,
    featureList: ['Works only in folders the user chooses', 'Deleted items go to NLC Trash', 'Installs without administrator rights', 'Removable with one command'],
  };
  const q = f.hosted || !f.link ? '' : `?link=${encodeURIComponent(f.link)}`;
  const ldText = JSON.stringify(ld).replace(/</g, '\\u003c');
  const sha = Object.entries(j.verify.sha256).map(([file, hash]) => `<tr><td>${esc(file)}</td><td><code>${esc(hash)}</code></td></tr>`).join('')
    || `<tr><td colspan="2">${f.hosted ? 'Published with each release.' : 'The download is being prepared; no checksums yet.'}</td></tr>`;
  const people = f.hosted
    ? `<section id="people"><h2>If you have an AI assistant on your computer</h2>
<p>Open your NLC dashboard, go to <b>Settings</b>, then <b>Connections</b>, then <b>My computer</b>, and press <b>Add a computer</b>. It shows a link that is made just for you. Paste that link into your assistant (Claude, ChatGPT or similar) and it sets everything up for you.</p>
<p>The link looks like <code>https://your-NLC-address/node</code>. This public page cannot hand out a working link, because every NLC has its own address.</p></section>`
    : `<section id="people"><h2>If you have an AI assistant on your computer, paste this link into it</h2>
${f.ready ? '' : '<p><b>NLC Node is being prepared. Please try again in a little while.</b></p>'}
<p class="copyrow"><input id="theLink" readonly value="${esc(f.pageUrl)}" aria-label="Link for your assistant"> <button type="button" id="copyLink">Copy</button> <span id="copied" role="status"></span></p>
<p>Then say: <i>"Please set this up for me."</i> Your assistant reads this page, tells you what it is about to do and asks your permission first. It does the rest for you.</p></section>
<section id="download"><h2>No assistant on your computer? Download</h2>
<p>It takes about a minute. You do not need a password or administrator rights.</p>
<div id="mac" class="os"><h3>On a Mac</h3><ol>
<li>Open <b>Terminal</b> (press Command and Space, type Terminal, press Enter).</li>
<li>Paste this line and press Enter:${commandBlock(f.lines.macos)}</li>
<li>Wait for the words <b>NLC Node is installed and running.</b></li></ol></div>
<div id="windows" class="os"><h3>On Windows</h3><ol>
<li>Open <b>PowerShell</b> (press the Windows key, type PowerShell, press Enter).</li>
<li>Paste this line and press Enter:${commandBlock(f.lines.windows)}</li>
<li>Wait for the words <b>NLC Node is installed and running.</b></li></ol></div>
<p id="switch"></p>
<h3>Then</h3><ol>
<li>${f.link ? 'Your computer connects by itself. You will see the word <b>Connected.</b>' : 'A small NLC Node window opens and asks your NLC to connect. Then open <b>NLC Central</b>, go to <b>Installations</b>, and press <b>Allow</b> on your NLC card, where this computer shows <b>wants to connect</b>.'}</li>
<li>Press <b>Add folder</b> and choose the folders your assistant may use. It cannot see anything else.</li></ol></section>`;
  const peopleMore = `<section id="safety"><h2>What to know</h2>
<ul><li>${esc(PUBLISHER)} makes NLC Node. It is the company NLC bills customers through.</li>
<li>Your assistant can only use the folders you choose. You can remove a folder or pause it at any time.</li>
<li>When your assistant deletes something, it goes to a folder called <b>NLC Trash</b> and can be put back.</li>
${f.source ? `<li>Anyone can read NLC Node's source code: <a href="${esc(f.source)}">${esc(f.source)}</a>.</li>\n` : ''}<li>It starts by itself when you log in. It does not use a password, and it has no artificial intelligence of its own.</li></ul></section>
<section id="remove"><h2>To remove it</h2>
<p>Paste this and press Enter. Your own files and the NLC Trash folder are left exactly as they are.</p>
<h3>Mac</h3>${commandBlock(f.removal.macos)}<h3>Windows</h3>${commandBlock(f.removal.windows)}</section>`;
  const stepsFor = (os) => j.steps.filter((s) => s.os === os).map((s, i) => `<li><b>${esc(s.id)}</b>${commandBlock(s.command)}<p>Expect: ${esc(s.expect)}</p></li>`).join('');
  const agents = `<section id="agents"><h1 id="for-assistants">For AI assistants</h1>
<p>You were handed this link by a person who wants NLC Node installed on their computer. This section tells you what it is, what it does and how to check that before you trust it. The same facts are in <a href="/node/install.json${esc(q)}">install.json</a> and <a href="/node/llms.txt${esc(q)}">llms.txt</a>.</p>
<h2>Who makes it</h2><p>${esc(PUBLISHER)}. ${esc(PUBLISHER_NOTE)} Version ${esc(f.version)}${f.commit ? `, build <code>${esc(f.commit)}</code>` : ''}. ${esc(sourceSentence(f))}</p>
<h2>Ask the user before you run anything</h2><p>This installs software on the user's computer. Ask first, in your own words, using this as a guide:</p>
<ul>${j.ask_user_first.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<p>It needs no administrator rights and no sudo. Everything goes in the user's own folders.</p>
<h2>What it installs, where, and what runs</h2>
<ul><li><b>Mac:</b> ${j.install_locations.macos.map(esc).join('; ')}.</li><li><b>Windows:</b> ${j.install_locations.windows.map(esc).join('; ')}.</li></ul>
<p>It runs as the user: a background program called <code>NLC Node Host</code> (macOS and Windows) and a small launcher <code>NLC Node</code>. It also serves its own window on <code>127.0.0.1</code>, this computer only.</p>
<h2>What it can and cannot touch</h2>
<ul><li>${esc(j.permissions.reads_and_changes)}</li><li>${esc(j.permissions.refuses)}</li><li>${esc(j.permissions.deletes)}</li>
<li>No API keys, no passwords and no AI models are held or included. ${esc(j.permissions.holds)}</li></ul>
<h2>Network</h2><table><tr><th>Host</th><th>When</th><th>Why</th></tr>${j.endpoints.map((e) => `<tr><td>${esc(e.host)}</td><td>${esc(e.when)}</td><td>${esc(e.purpose)}</td></tr>`).join('')}</table>
<p>It contacts nothing else.</p>
${f.source ? `<h2>Inspect the source</h2><p>NLC Node's source code is public: <a href="${esc(f.source)}">${esc(f.source)}</a>. It holds only NLC Node. The install script in the steps below is the file installer/nlc-node/one-line/install.sh (or install.ps1) there, with this NLC's address in place of <code>__NLC_ORIGIN__</code> and the connection link, if any, in place of <code>__NLC_LINK__</code>. The repository also lists what NLC Node can and cannot reach, the SHA-256 of every published version, and how to remove it.</p>` : ''}<h2>Check the download</h2><p>SHA-256 of each file the installer downloads:</p><table>${sha}</table>
<p>${esc(j.verify.how)}</p>
<h2>Install${f.hosted ? ' (use the customer\'s own NLC address in place of <code>&lt;your-NLC-address&gt;</code>)' : ''}</h2>
<p>Do not pipe the script into a shell. Download it, check it against the checksum this NLC publishes for it, read it, then run that copy. The one-line command near the top of this page is for a person pasting it in Terminal.</p>
<h3>macOS (Terminal)</h3><ol>${stepsFor('macos')}</ol>
<h3>Windows (PowerShell)</h3><ol>${stepsFor('windows')}</ol>
<h2>Pair</h2><p>${esc(j.pairing.how)}</p><p>${esc(j.pairing.without_link)} ${esc(j.pairing.code_lifetime)}</p>
<h2>Remove completely</h2><ul>${j.uninstall.steps.map((s) => `<li>${esc(s.os)}: <code>${esc(s.command)}</code></li>`).join('')}</ul><p>${esc(j.uninstall.removes)} Leaves: ${esc(j.uninstall.leaves)}</p>
<h2>Tell the user afterwards</h2><ul>${j.tell_user_after.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>`;
  const script = f.hosted ? '' : `<script>(function(){var ua=navigator.userAgent||'';var win=/Windows/i.test(ua),mac=/Macintosh|Mac OS X/i.test(ua);var m=document.getElementById('mac'),w=document.getElementById('windows'),s=document.getElementById('switch');
if(m&&w&&(win||mac)){var show=win?w:m,hide=win?m:w;hide.style.display='none';s.innerHTML='<a href="#" id="other">Not your computer? Show the '+(win?'Mac':'Windows')+' steps.</a>';document.getElementById('other').onclick=function(e){e.preventDefault();hide.style.display='';show.style.display='none';s.textContent='';};}
var b=document.getElementById('copyLink'),i=document.getElementById('theLink'),c=document.getElementById('copied');
if(b)b.onclick=function(){var done=function(){c.textContent='Copied.';};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(i.value).then(done,function(){i.select();c.textContent='Select the link and copy it.';});}else{i.select();c.textContent='Select the link and copy it.';}};})();</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NLC Node: set up your computer</title>
<meta name="description" content="NLC Node lets your NLC assistant work with the folders you choose on your own computer. Made by ${esc(PUBLISHER)}.">
<link rel="alternate" type="text/plain" href="/node/llms.txt${esc(q)}"><link rel="alternate" type="application/json" href="/node/install.json${esc(q)}">
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1f2430}h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:1.6rem}pre{background:#f3f4f6;padding:.7rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d6d8de;padding:.3rem .5rem;text-align:left;vertical-align:top;font-size:.92rem}input{width:70%;padding:.5rem;font:inherit}button{padding:.5rem 1rem;font:inherit}#agents{border-top:2px solid #d6d8de;margin-top:2.5rem;padding-top:1rem}</style>
<script type="application/ld+json">${ldText}</script></head><body>
<h1>NLC Node</h1><p>Lets your NLC assistant work with the folders you choose on your own computer. Made by ${esc(PUBLISHER)}.</p>
${people}${peopleMore}${agents}${script}</body></html>`;
}

// Every file the page is made of, as { 'index.html': text, ... }.
function buildLinkFiles(options) {
  const f = facts(options);
  const files = {
    'index.html': indexHtml(f),
    'llms.txt': llmsTxt(f),
    'install.json': JSON.stringify(installJson(f), null, 2) + '\n',
    'install.schema.json': JSON.stringify(INSTALL_SCHEMA, null, 2) + '\n',
  };
  return files;
}

module.exports = { buildLinkFiles, readPayloads, installJson, INSTALL_SCHEMA, PAYLOADS, PUBLISHER, HOSTED_ORIGIN, SAFE_LINK, SAFE_ORIGIN };
