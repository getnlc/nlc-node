'use strict';
// What a reader of the NLC Node link page sees: every section is there, install.json follows its own schema, the checksums
// on the page are the payload checksum files, nothing is left unfilled, and the people part has no jargon.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLinkFiles, readPayloads, INSTALL_SCHEMA, PAYLOADS } = require('../../lib/nlc-node/link-page-render.cjs');
const { generate } = require('../../scripts/nlc-node/build-link-page.cjs');

function payloadDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-linkpage-'));
  const hashes = {};
  for (const p of PAYLOADS) {
    const bytes = crypto.randomBytes(64);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(dir, p.file), bytes);
    fs.writeFileSync(path.join(dir, `${p.file}.sha256`), `${hash}  ${p.file}\n`);
    hashes[p.file] = hash;
  }
  return { dir, hashes };
}
const render = (extra = {}) => {
  const { dir, hashes } = payloadDir();
  return { hashes, files: buildLinkFiles({ mode: 'vps', origin: 'https://nlc.example.com', version: '0.1.0', commit: 'abc1234567', sha256: readPayloads(dir), ...extra }) };
};

// A small checker for the part of JSON Schema the schema uses.
function validate(value, schema, where = 'install.json') {
  const errors = [];
  const types = [].concat(schema.type || []);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types.length && !types.some((t) => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) return [`${where}: expected ${types.join('/')}, got ${typeOf(value)}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: does not match ${schema.pattern}`);
  if (schema.minLength && String(value).length < schema.minLength) errors.push(`${where}: too short`);
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${where}: missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validate(value[key], sub, `${where}.${key}`));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') for (const [key, v] of Object.entries(value)) errors.push(...validate(v, schema.additionalProperties, `${where}.${key}`));
  }
  if (typeOf(value) === 'array') {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, `${where}[${i}]`)));
  }
  return errors;
}

const agentSection = (html) => html.slice(html.indexOf('<section id="agents">'));
const peopleView = (html) => html.slice(html.indexOf('<h1>NLC Node</h1>'), html.indexOf('<section id="agents">'));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('LINK: the people part leads with the paste-this-link box and the Copy button, then the download for no-assistant readers', () => {
  const { files } = render({ link: 'https://nlc.example.com/n/ABC-123' });
  const view = peopleView(files['index.html']);
  assert.ok(view.indexOf('If you have an AI assistant on your computer, paste this link into it') < view.indexOf('No assistant on your computer? Download'));
  assert.match(view, /<input id="theLink" readonly value="https:\/\/nlc\.example\.com\/node\?link=https%3A%2F%2Fnlc\.example\.com%2Fn%2FABC-123"/);
  assert.match(view, /<button type="button" id="copyLink">Copy<\/button>/);
  assert.match(view, /curl -fsSL &quot;https:\/\/nlc\.example\.com\/downloads\/nlc-node\/install\.sh\?link=/);
  assert.match(view, /irm &quot;https:\/\/nlc\.example\.com\/downloads\/nlc-node\/install\.ps1\?link=/);
  assert.match(view, /Terminal/); assert.match(view, /PowerShell/);
});

test('LINK: the assistant part has every section an assistant needs to decide to trust and to install', () => {
  const { files } = render();
  const agent = text(agentSection(files['index.html']));
  for (const heading of ['For AI assistants', 'Who makes it', 'Ask the user before you run anything', 'What it installs, where, and what runs', 'What it can and cannot touch', 'Network', 'Check the download', 'Install', 'Pair', 'Remove completely', 'Tell the user afterwards']) {
    assert.ok(agent.includes(heading), `missing section: ${heading}`);
  }
  assert.match(agent, /FTay Consulting Sdn Bhd/);
  assert.match(agent, /source code of NLC Node \(only NLC Node, not the rest of NLC\) is public at https:\/\/github\.com\/getnlc\/nlc-node/);
  assert.match(agent, /needs no administrator rights and no sudo/);
  assert.match(agent, /huggingface\.co/);
  assert.match(agent, /NLC Trash/);
  assert.match(agent, /--uninstall/);
  assert.match(agent, /NLC_NODE_UNINSTALL/);
  assert.match(agent, /NLC Node is installed and running/);
  assert.match(agent, /127\.0\.0\.1/);
  const llms = files['llms.txt'];
  for (const heading of ['## Ask the user first', '## What it installs', '## What it can and cannot touch', '## Network', '## Check the download', '## Install', '## Pair', '## Remove completely', '## Tell the user afterwards']) assert.ok(llms.includes(heading), `llms.txt missing ${heading}`);
  assert.match(llms, /^# NLC Node/);
});

test('LINK: the page states no registration number or anything the record does not hold', () => {
  const { files } = render();
  const all = Object.values(files).join('\n');
  assert.doesNotMatch(all, /\b\d{12}\b/);
  assert.doesNotMatch(all, /\(\d{6,}-?[A-Z]\)/);
});

test('LINK: install.json follows its own schema, hosted copy too', () => {
  const { files } = render();
  assert.deepEqual(JSON.parse(files['install.schema.json']), JSON.parse(JSON.stringify(INSTALL_SCHEMA)));
  const doc = JSON.parse(files['install.json']);
  assert.deepEqual(validate(doc, INSTALL_SCHEMA), []);
  assert.deepEqual(doc.steps.filter((s) => s.os === 'macos').map((s) => s.id), ['check-download', 'download-script', 'check-script', 'read-script', 'run-script', 'confirm-running', 'share-folder']);
  assert.deepEqual(doc.steps.filter((s) => s.os === 'windows').map((s) => s.id), ['check-download', 'download-script', 'check-script', 'read-script', 'run-script', 'confirm-running', 'share-folder']);
  const hosted = JSON.parse(buildLinkFiles({ mode: 'hosted', version: '0.1.0' })['install.json']);
  assert.deepEqual(validate(hosted, INSTALL_SCHEMA), []);
  // the checker really catches a broken file
  const broken = { ...doc }; delete broken.pairing; broken.steps = [{ os: 'linux' }];
  assert.ok(validate(broken, INSTALL_SCHEMA).length >= 2);
});

test('LINK: the checksums on the page are exactly the payload .sha256 files', () => {
  const { files, hashes } = render();
  const doc = JSON.parse(files['install.json']);
  assert.deepEqual(doc.verify.sha256, hashes);
  for (const [file, hash] of Object.entries(hashes)) {
    assert.ok(files['index.html'].includes(`<td>${file}</td><td><code>${hash}</code></td>`), `${file} hash missing from the page`);
    assert.ok(files['llms.txt'].includes(`- ${file}: ${hash}`), `${file} hash missing from llms.txt`);
  }
});

test('LINK: a payload without a valid checksum file is not listed, and the page says it is being prepared', () => {
  const files = buildLinkFiles({ mode: 'vps', origin: 'https://nlc.example.com', version: '0.1.0', sha256: {} });
  assert.equal(JSON.parse(files['install.json']).status, 'preparing');
  assert.match(peopleView(files['index.html']), /being prepared/);
  assert.deepEqual(readPayloads(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-empty-'))), {});
});

test('LINK: no unfilled placeholder is left (customer copy: none at all; public copy: only the named address blank)', () => {
  const { files } = render({ link: 'https://nlc.example.com/n/ABC-123' });
  for (const [name, body] of Object.entries(files)) {
    assert.doesNotMatch(body, /__NLC_(?!ORIGIN__|LINK__)|\{\{|undefined|\[object Object\]|TODO|<your-NLC-address>/, `${name} has an unfilled part`); // ORIGIN and LINK are named on purpose in the source paragraph
    assert.ok(!/(?<!in place of <code>)(?<!in place of the <code>)__NLC_(ORIGIN|LINK)__(?!<\/code>)/.test(body.replace(/<code>__NLC_(ORIGIN|LINK)__<\/code>/g, '')) || name === 'llms.txt' || name === 'install.json', `${name} leaves a placeholder outside the source paragraph`);
  }
  const hosted = buildLinkFiles({ mode: 'hosted', version: '0.1.0' });
  for (const [name, body] of Object.entries(hosted)) assert.doesNotMatch(body, /__NLC_(?!ORIGIN__|LINK__)|\{\{|undefined|\[object Object\]|TODO/, `${name} (public copy) has an unfilled part`);
  assert.match(hosted['index.html'], /Settings<\/b>, then <b>Connections<\/b>, then <b>My computer/);
  assert.doesNotMatch(peopleView(hosted['index.html']), /id="theLink"/);
});

test('LINK: the people part uses no jargon', () => {
  for (const mode of [{ mode: 'vps', origin: 'https://nlc.example.com' }, { mode: 'hosted' }]) {
    const files = buildLinkFiles({ version: '0.1.0', sha256: {}, ...mode });
    const words = text(peopleView(files['index.html'])).toLowerCase();
    for (const bad of ['token', 'websocket', 'grant', 'module', 'endpoint', 'sha-256', 'checksum', 'api', 'daemon', 'payload']) {
      assert.ok(!new RegExp(`\\b${bad}`).test(words), `jargon word in the people part: ${bad}`);
    }
  }
});

test('LINK: the page carries a valid SoftwareApplication description', () => {
  const { files } = render();
  const m = files['index.html'].match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'no ld+json');
  const ld = JSON.parse(m[1]);
  assert.equal(ld['@type'], 'SoftwareApplication');
  assert.equal(ld.name, 'NLC Node');
  assert.equal(ld.publisher.name, 'FTay Consulting Sdn Bhd');
  assert.match(ld.operatingSystem, /macOS/);
});

test('LINK: unsafe addresses and links are refused, never printed', () => {
  assert.throws(() => buildLinkFiles({ mode: 'vps', origin: 'https://x.example/"><script>', version: '1', sha256: {} }));
  assert.throws(() => buildLinkFiles({ mode: 'vps', origin: 'https://nlc.example.com', link: 'javascript:alert(1)', version: '1', sha256: {} }));
});

test('LINK: the generator writes the four files with the real checksums', () => {
  const { dir, hashes } = payloadDir();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-linkout-'));
  const names = generate({ out, payloadDir: dir, mode: 'hosted', version: '0.1.0', commit: 'abc' });
  assert.deepEqual(names.sort(), ['index.html', 'install.json', 'install.schema.json', 'llms.txt']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'install.json'), 'utf8')).verify.sha256, hashes);
});

test('LINK: every reference to install.json and llms.txt on a page opened with a connection link carries that link, so a reader who follows any of them still pairs', () => {
  const { files } = render({ link: 'https://nlc.example.com/n/ABC-123' });
  const hrefs = [...files['index.html'].matchAll(/href="(\/node\/(?:install\.json|llms\.txt)[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 4);
  for (const href of hrefs) assert.ok(href.includes('?link=https%3A%2F%2Fnlc.example.com%2Fn%2FABC-123'), `${href} lost the link`);
});

test('HF-20: the page tells a customer with no assistant exactly where to press Allow, and names no Central page that does not exist', () => {
  const { files } = render();
  const people = text(peopleView(files['index.html']));
  assert.match(people, /open NLC Central\s*,\s*go to Installations\s*,\s*and press Allow on your NLC card\s*,\s*where this computer shows wants to connect/i);
  for (const name of ['index.html', 'llms.txt', 'install.json']) {
    assert.doesNotMatch(text(files[name]), /NLC Node page/, name + ' names an NLC Node page in Central, which does not exist');
  }
  assert.match(text(files['llms.txt']), /Installations/);
});

test('LINK: an assistant is told to download the script, check its published checksum, read it and run that copy; the one-line command stays for a person', () => {
  const { files } = render({ link: 'https://nlc.example.com/n/ABC-123' });
  const doc = JSON.parse(files['install.json']);
  assert.match(doc.one_line_for_a_person.macos, /install\.sh\?link=.*\| sh$/);
  assert.match(doc.one_line_for_a_person.windows, /\| iex$/);
  for (const osName of ['macos', 'windows']) {
    const steps = doc.steps.filter((x) => x.os === osName);
    assert.ok(!steps.some((x) => /\|\s*(sh|iex)\b/.test(x.command)), `${osName}: no assistant step pipes into a shell`);
    const script = osName === 'macos' ? 'install.sh' : 'install.ps1';
    assert.match(steps.find((x) => x.id === 'download-script').command, new RegExp(`${script.replace('.', '\\.')}\\?link=.*(-o|-OutFile) nlc-node-install`));
    assert.match(steps.find((x) => x.id === 'check-script').command, new RegExp(`${script.replace('.', '\\.')}\\.sha256\\?link=`));
    assert.match(steps.find((x) => x.id === 'run-script').command, /nlc-node-install\.(sh|ps1)/);
    assert.ok(doc.verify.script.sha256_urls[osName].includes(`${script}.sha256?link=`));
  }
  const text = files['llms.txt'];
  assert.match(text, /Do not pipe the script into a shell/);
  assert.match(text, /Mac \(Terminal\):\n1\. .*\n.*\n2\. curl .* -o nlc-node-install\.sh/);
  assert.match(files['index.html'], /Do not pipe the script into a shell/);
});

test('LINK: while no public repository is published the page says the source is on request; once one is, every output links it and says it holds only NLC Node', () => {
  const none = render({ source: '' });
  assert.equal(JSON.parse(none.files['install.json']).verify.source.public, false);
  assert.match(none.files['index.html'], /private repository and is available on request/);
  const url = 'https://github.com/example-org/nlc-node';
  const set = render({ source: url });
  const doc = JSON.parse(set.files['install.json']);
  assert.equal(doc.verify.source.public, true);
  assert.equal(doc.verify.source.url, url);
  for (const name of ['index.html', 'llms.txt']) {
    assert.ok(set.files[name].includes(url), `${name} links the repository`);
    assert.match(set.files[name], /only NLC Node/);
    assert.ok(!/private repository/.test(set.files[name]), `${name} no longer says the source is private`);
  }
  assert.match(set.files['index.html'], /Inspect the source/);
  assert.match(set.files['index.html'], /__NLC_ORIGIN__/);
  const unsafe = render({ source: 'https://evil.example.com/x' });
  assert.equal(JSON.parse(unsafe.files['install.json']).verify.source.public, false);
});
