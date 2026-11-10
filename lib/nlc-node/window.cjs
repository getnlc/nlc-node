'use strict';

// The Node window: a plain page on the loopback server. Shows a connection light,
// the pairing box (only before pairing), shared folders, a pause switch and recent activity.

const fs = require('node:fs');
const path = require('node:path');

const UI_DIR = path.join(__dirname, 'ui');
// In the built program the page files are carried inside it (bundle-core); from source they are read from the ui folder.
function readUi(name) {
  const carried = globalThis.__NLC_NODE_UI__;
  if (carried && typeof carried[name] === 'string') return carried[name];
  return fs.readFileSync(path.join(UI_DIR, name), 'utf8');
}
const WRONG_CODE = 'That code did not work. Ask your assistant for a new one.';
const OFFLINE_MESSAGE = 'Could not reach NLC. Check your internet connection and try again.';
const RATE_LIMIT_MESSAGE = 'Too many tries. Wait a minute and try again.';
const NO_ORIGIN_MESSAGE = 'This computer does not know where to connect yet. Paste the whole connection link you were given.';

const FILES = {
  '/window': ['index.html', 'text/html; charset=utf-8'],
  '/window/tokens.css': ['tokens.css', 'text/css; charset=utf-8'],
  '/window/window.css': ['window.css', 'text/css; charset=utf-8'],
  '/window/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const ACTIONS = {
  list: 'Looked in', stat: 'Checked a file in', search: 'Searched in', read_text: 'Read a file in',
  write_text: 'Wrote a file in', edit: 'Edited a file in', make_folder: 'Made a folder in', rename: 'Renamed a file in',
  move: 'Moved a file in', copy: 'Copied a file in', delete: 'Moved a file to NLC Trash from', trash_list: 'Looked at NLC Trash for',
  trash_restore: 'Restored a file to',
  media_info: 'Checked a video in', video_trim: 'Trimmed a video in', video_join: 'Joined videos in',
  video_captions: 'Added captions to a video in', video_proxy: 'Made a small copy of a video in',
  video_frames: 'Saved pictures from a video in', audio_mux: 'Added sound to a video in',
  captions_from_audio: 'Made captions from speech in',
  set_paused: 'Changed the pause switch',
};
// Housekeeping calls that would only fill the list with noise.
const HIDDEN_TOOLS = new Set(['job_status', 'job_cancel', 'captions_status', 'captions_cancel', 'log_recent', 'computer_status']);

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function describeActivity(entry) {
  const verb = ACTIONS[entry.tool] || 'Used your computer in';
  const where = entry.folder ? `${entry.folder}${entry.path ? `/${String(entry.path).replace(/\\/g, '/')}` : ''}` : '';
  let when = '';
  const date = new Date(entry.ts);
  if (!Number.isNaN(date.getTime())) when = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { when, text: where ? `${verb} ${where}` : verb.replace(/ (in|from|to|for)$/, ''), failed: entry.ok === false };
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// What the customer typed: a bare code, or the connection link https://<their NLC address>/n/<CODE>.
// Returns { code, origin? } or null when it is neither. A plain http address is only accepted on this same computer.
function parseConnectInput(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const code = normalizeCode(text);
    return code ? { code } : null;
  }
  let url;
  try { url = new URL(text); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return null;
  if (!url.hostname || url.username || url.password) return null;
  const match = /^\/n\/([A-Za-z0-9-]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const code = normalizeCode(match[1]);
  return code ? { code, origin: url.origin } : null;
}

function createWindow({ grants, actionLog, connectionState, machineName = 'This computer', addFolder = null, nlcFolder = '', openFolder = null, openCentral = null, pickFolderPath = null }) {
  const pick = addFolder || (async () => require('./picker.cjs').pickAndShare({ grants }));

  async function readActivity() {
    try {
      const out = await actionLog.tools.log_recent({ limit: 60 }, {});
      const lines = Array.isArray(out) ? out : (out && (out.lines || out.entries)) || [];
      return lines.map((line) => (typeof line === 'string' ? JSON.parse(line) : line))
        .filter((entry) => !HIDDEN_TOOLS.has(entry.tool))
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 20);
    } catch {
      return [];
    }
  }

  const samePlace = (a, b) => String(a || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const waiting = () => ['asking', 'unpaired', 'expired'].includes(connectionState.getState());

  function indicator() {
    const state = connectionState.getState();
    // One calm waiting screen: the owner presses Allow in NLC Central; asking again happens by itself.
    if (['unpaired', 'asking', 'expired'].includes(state)) return { kind: 'paused', title: 'Waiting for you to press Allow in NLC Central', hint: 'Open Installations, find your NLC card, and press Allow where this computer shows wants to connect.' };
    if (state === 'denied') return { kind: 'offline', title: 'Not allowed', hint: 'The owner did not allow this computer. You can ask again.' };
    if (state === 'disconnected') return { kind: 'offline', title: 'Disconnected', hint: 'This computer was disconnected from your agents. Enter a new code to connect again.' };
    if (state === 'replaced') return { kind: 'offline', title: 'Another copy of NLC Node took over', hint: 'NLC Node is open somewhere else for this computer. Close the other copy, then open NLC Node again here.' };
    if (state === 'offline') return { kind: 'offline', title: 'Offline', hint: 'Trying to reconnect.' };
    if (state === 'paused' || grants.isPaused()) return { kind: 'paused', title: 'Paused', hint: `${machineName}. Your agents cannot reach your files right now.` };
    return { kind: 'connected', title: 'Connected', hint: `${machineName} is connected to your agents.` };
  }

  async function renderView() {
    const status = indicator();
    const unpaired = connectionState.getState() === 'disconnected';
    const paused = grants.isPaused();
    const folders = grants.list();
    const activity = (await readActivity()).map(describeActivity);
    const parts = [];
    const codeBox = waiting() ? '<details class="code"><summary>Have a code?</summary><form class="pair" aria-label="Connect"><label class="hint" for="pair-code">Only if you were given a code or link, enter it here</label><input id="pair-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="300"><button type="submit">Connect</button></form></details><div id="message" aria-live="polite"></div>' : '';
    const autoAsk = ['unpaired', 'expired'].includes(connectionState.getState()) ? ' data-auto-ask="1"' : '';
    parts.push(`<section class="card status" role="status" aria-live="polite"${autoAsk}><span class="dot ${status.kind}" aria-hidden="true"></span><div><div class="status-title">${escapeHtml(status.title)}</div><div class="hint">${escapeHtml(status.hint)}</div>${waiting() ? '<button type="button" data-action="open-central">Open NLC Central</button>' : ''}${codeBox}</div></section>`);
    if (connectionState.getState() === 'denied') {
      parts.push('<section class="card" aria-label="Ask again"><h2>Ask your NLC again</h2><button type="button" data-action="ask">Try again</button><div id="message" aria-live="polite"></div></section>');
    }
    if (unpaired) {
      parts.push(`<form class="card pair" aria-label="Connect"><h2>Connect this computer</h2><p class="hint">No code? Just press <b>Allow</b> in NLC Central. Open <b>Installations</b>, find your NLC card, and press <b>Allow</b> where this computer shows <b>wants to connect</b>.</p><label class="hint" for="pair-code">Only if you were given a code or link, enter it here</label><input id="pair-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="300"><button type="submit">Connect</button></form>`);
    }
    parts.push(`<section class="card" aria-label="Shared folders"><h2>Shared folders</h2><p class="hint">Your agents can open, change and move files in these folders. Deleted files go to NLC Trash. Stopping sharing deletes nothing.</p>`);
    if (folders.length === 0) parts.push('<p class="hint gap">No folders shared yet.</p>');
    else {
      parts.push('<ul class="folders" role="list">');
      for (const folder of folders) {
        const mine = nlcFolder && samePlace(folder.path, nlcFolder);
        const label = escapeHtml(folder.label);
        const title = mine ? 'Your NLC folder' : escapeHtml(folder.label);
        const note = mine ? '<div class="hint">Put files here and your agents can use them.</div>' : '';
        parts.push(`<li class="folder${mine ? ' nlc' : ''}"><div><div class="folder-name">${title}</div>${note}<div class="folder-path">${escapeHtml(folder.path)}</div></div><div class="folder-actions"><button type="button" data-action="open-folder" data-label="${label}">Open folder</button><button type="button" class="quiet" data-action="replace" data-label="${label}">Choose a different folder</button><button type="button" class="quiet" data-action="remove" data-label="${label}">Stop sharing</button></div></li>`);
      }
      parts.push('</ul>');
    }
    parts.push('<div class="add"><button type="button" data-action="add">Share another folder</button></div><div id="message" aria-live="polite"></div></section>');
    parts.push(`<section class="card switch-row" aria-label="Pause"><div><h2>Pause file access</h2><div class="hint">${paused ? 'Your agents cannot reach your files until you turn this off.' : 'Turn on to stop your agents using your files.'}</div></div><button type="button" class="switch" role="switch" aria-label="Pause file access" aria-checked="${paused ? 'true' : 'false'}" data-action="pause"></button></section>`);
    parts.push('<section class="card activity" aria-label="Recent activity"><h2>Recent activity</h2>');
    if (activity.length === 0) parts.push('<p class="hint">Nothing yet. What your agents do with your files will show here.</p>');
    else {
      parts.push('<ul role="list">');
      for (const item of activity) parts.push(`<li><span class="when">${escapeHtml(item.when)}</span> <span class="${item.failed ? 'failed' : ''}">${escapeHtml(item.text)}${item.failed ? ' (did not work)' : ''}</span></li>`);
      parts.push('</ul>');
    }
    parts.push('</section>');
    return parts.join('');
  }

  const cache = new Map();
  function windowPage(url) {
    const pathname = String(url).split('?')[0].split('#')[0];
    const entry = FILES[pathname];
    if (!entry) return null;
    if (!cache.has(pathname)) cache.set(pathname, readUi(entry[0]));
    return { type: entry[1], body: cache.get(pathname) };
  }

  async function windowApi(method, url, body) {
    const route = `${method} ${String(url).split('?')[0]}`;
    if (route === 'GET /v1/window/view') return { text: await renderView() };
    if (route === 'POST /v1/window/pair') {
      const parsed = parseConnectInput(body && body.code);
      if (!parsed) return { json: { ok: false, message: WRONG_CODE } };
      try {
        await connectionState.pair(parsed.code, parsed.origin ? { origin: parsed.origin } : undefined);
        return { json: { ok: true, message: 'Connected.' } };
      } catch (error) {
        const code = error && error.code;
        const message = code === 'OFFLINE' ? OFFLINE_MESSAGE : code === 'RATE_LIMIT' ? RATE_LIMIT_MESSAGE : code === 'NO_ORIGIN' ? NO_ORIGIN_MESSAGE : WRONG_CODE;
        return { json: { ok: false, message } };
      }
    }
    if (route === 'POST /v1/window/request') {
      try {
        await connectionState.requestLink();
        return { json: { ok: true, message: 'Asked your NLC. Press Allow in NLC Central: open Installations, find your NLC card, and press Allow where this computer shows wants to connect.' } };
      } catch (error) {
        return { json: { ok: false, message: error && error.code === 'NO_ORIGIN' ? NO_ORIGIN_MESSAGE : OFFLINE_MESSAGE } };
      }
    }
    if (route === 'POST /v1/window/folders/add') {
      // An assistant on this computer names the folder itself (the person told it in chat); no dialog opens.
      // The same refusals as the Add folder button apply: no home folder, no system folder, nothing of Node's own.
      if (body && typeof body.path === 'string' && body.path.trim()) {
        try {
          const grant = await grants.add(body.path);
          return { json: { ok: true, label: grant.label, path: grant.path, message: `${grant.label} is shared. Your agents can open, change and move files in it. Deleted files go to NLC Trash.` } };
        } catch (error) {
          return { json: { ok: false, message: (error && error.message) || 'Choose a folder for your work, not a system location.' } };
        }
      }
      const out = await pick();
      if (out.status === 'added') return { json: { ok: true, label: out.grant.label, message: `${out.grant.label} is shared. Your agents can open, change and move files in it. Deleted files go to NLC Trash.` } };
      if (out.status === 'cancelled') return { json: { ok: true, message: '' } };
      return { json: { ok: false, message: out.message || 'Choose a folder for your work, not a system location.' } };
    }
    if (route === 'POST /v1/window/folders/remove') {
      const label = String((body && body.label) || '');
      const exists = grants.list().some((g) => g.label === label);
      if (!exists) return { json: { ok: false, message: 'That folder is not in the list.' } };
      await grants.remove(label);
      return { json: { ok: true, message: `${label} is no longer shared.` } };
    }
    if (route === 'POST /v1/window/folders/open') {
      const label = String((body && body.label) || '');
      const folder = grants.list().find((g) => g.label === label);
      if (!folder) return { json: { ok: false, message: 'That folder is not in the list.' } };
      if (!openFolder) return { json: { ok: false, message: 'This computer could not open the folder. Find it in Finder or File Explorer.' } };
      try { await openFolder(folder.path); return { json: { ok: true, message: '' } }; } catch { return { json: { ok: false, message: 'This computer could not open the folder. Find it in Finder or File Explorer.' } }; }
    }
    if (route === 'POST /v1/window/folders/replace') {
      const label = String((body && body.label) || '');
      if (!grants.list().some((g) => g.label === label)) return { json: { ok: false, message: 'That folder is not in the list.' } };
      let chosen;
      try { chosen = await (pickFolderPath || (() => require('./picker.cjs').pickFolder()))(); } catch (error) { return { json: { ok: false, message: (error && error.message) || 'Choose a folder for your work, not a system location.' } }; }
      if (!chosen) return { json: { ok: true, message: '' } };
      try {
        await grants.replace(label, chosen);
        return { json: { ok: true, message: `${label} now points to the folder you chose. Nothing was deleted from the old folder.` } };
      } catch (error) {
        return { json: { ok: false, message: (error && error.message) || 'Choose a folder for your work, not a system location.' } };
      }
    }
    if (route === 'POST /v1/window/open-central') {
      if (!openCentral) return { json: { ok: false, message: 'Open NLC Central in your browser and go to Installations.' } };
      try { await openCentral(); return { json: { ok: true, message: '' } }; } catch { return { json: { ok: false, message: 'Open NLC Central in your browser and go to Installations.' } }; }
    }
    if (route === 'POST /v1/window/pause') {
      const paused = Boolean(body && body.paused);
      await grants.setPaused(paused);
      return { json: { ok: true, paused, message: paused ? 'Paused. Your agents cannot reach your files.' : 'Resumed.' } };
    }
    return null;
  }

  return { windowPage, windowApi, renderView, WRONG_CODE };
}

module.exports = { createWindow, WRONG_CODE, normalizeCode, parseConnectInput };

function buildWindowUrl({ port, token }) {
  return `http://127.0.0.1:${port}/window#k=${encodeURIComponent(token)}`;
}
module.exports.buildWindowUrl = buildWindowUrl;
