'use strict';
// "Your NLC folder": one folder named NLC on the Desktop, made and shared automatically the first time.
// A person who later chooses Stop sharing is not overruled: it is offered once, then left alone. Nothing is ever deleted.
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'nlc-folder.json';

function desktopDir(homeDir, fsApi = fs) {
  const candidates = [path.join(homeDir, 'Desktop'), path.join(homeDir, 'OneDrive', 'Desktop')];
  return candidates.find((dir) => { try { return fsApi.statSync(dir).isDirectory(); } catch { return false; } }) || candidates[0];
}

function nlcFolderPath(homeDir, fsApi = fs) {
  return path.join(desktopDir(homeDir, fsApi), 'NLC');
}

async function ensureNlcFolder({ grants, homeDir, stateDir, fsApi = fs }) {
  const folder = nlcFolderPath(homeDir, fsApi);
  fsApi.mkdirSync(folder, { recursive: true });
  const marker = path.join(stateDir, MARKER);
  let offered = false;
  try { offered = JSON.parse(fsApi.readFileSync(marker, 'utf8')).offered === true; } catch { offered = false; }
  if (offered) return { path: folder, shared: false };
  let grant;
  try { grant = await grants.add(folder); } catch (error) { return { path: folder, shared: false, error: error && error.message }; }
  try { fsApi.writeFileSync(marker, JSON.stringify({ offered: true, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); } catch { /* offered again next start */ }
  return { path: folder, shared: true, grant };
}

module.exports = { ensureNlcFolder, nlcFolderPath, MARKER };
