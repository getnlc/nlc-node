'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MARKER = 'nlc-node-central-client:v1';

// This function is embedded in the existing Central caller. It owns no resident process or credentials.
function callNodeCore(options, input) {
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
  if (process.env.NLC_NODE_CORE_CLIENT_BYPASS === '1') return null;
  let mode;
  try { mode = JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'central-bridge.json'), 'utf8')).mode; } catch { return null; }
  if (mode !== 'node' || !fs.existsSync(options.executable)) return null;
  const result = cp.spawnSync(options.executable, [...options.prefix, '--central-event', '--runtime', options.runtime], {
    input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  try { const packet = JSON.parse(result.stdout); if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null; } catch { return null; }
  return result.stdout;
}
function configureCentralClients({
  homeDir = os.homedir(), stateRoot, programDir = path.dirname(process.execPath),
  coreExecutable = path.join(programDir, 'NLC Node Host.exe'), corePrefixArguments = [],
} = {}) {
  if (!stateRoot) throw Error('Use the existing Node state directory.');
  const counts = { claude: 0, codex: 0 }, writes = [], originals = [];
  const options = runtime => ({ stateRoot, executable: coreExecutable, prefix: corePrefixArguments, runtime });
  const expression = runtime => '(' + callNodeCore.toString() + ')(' + JSON.stringify(options(runtime)) + ',input)';
  function patchInline(source, runtime) {
    if (!source.includes('nlc-central-warm-launch:v1')) return null;
    counts[runtime]++;
    if (source.includes(MARKER)) return source;
    const anchor = 'startRefresh();';
    if (!source.includes(anchor)) return null;
    return source.replace(anchor, '/*' + MARKER + '*/{const nodeReply=' + expression(runtime) + ';if(nodeReply!==null){process.stdout.write(nodeReply);return;}}' + anchor);
  }
  for (const [runtime, relative] of [['claude', '.claude/settings.json'], ['codex', '.codex/hooks.json']]) {
    const file = path.join(homeDir, relative);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    let config; try { config = JSON.parse(before); } catch { return { ok: false, message: 'The existing ' + runtime + ' hook settings are not valid JSON. Their contents were left unchanged.' }; }
    let changed = false;
    for (const entries of Object.values(config.hooks || {})) for (const entry of entries || []) for (const hook of entry.hooks || []) {
      if (!Array.isArray(hook.args)) continue;
      hook.args = hook.args.map(argument => {
        if (typeof argument !== 'string') return argument;
        const updated = patchInline(argument, runtime);
        if (updated !== null && updated !== argument) { changed = true; originals.push({ file, runtime, before: argument }); return updated; }
        return argument;
      });
    }
    if (changed) writes.push({ file, body: JSON.stringify(config, null, 2) + '\n' });
  }
  const warmFiles = new Set([path.join(homeDir, '.codex', 'hooks', 'nlc-central-warm-launch.cjs')]);
  const childrenFile = path.join(homeDir, '.codex', 'hooks', 'nlc-userprompt-dispatch.children.json');
  try {
    const children = JSON.parse(fs.readFileSync(childrenFile, 'utf8')).children;
    for (const child of children || []) if (child.name === 'central-context-producer' && child.role !== 'catchup' && Array.isArray(child.args)) {
      const file = child.args[0];
      if (typeof file === 'string' && path.isAbsolute(file) && path.basename(file) === 'nlc-central-warm-launch.cjs') warmFiles.add(file);
    }
  } catch {}
  for (const warm of warmFiles) if (fs.existsSync(warm)) {
    const before = fs.readFileSync(warm, 'utf8');
    const inline = patchInline(before, 'codex');
    if (inline !== null) {
      if (inline !== before) { originals.push({ file: warm, runtime: 'codex', before }); writes.push({ file: warm, body: inline }); }
      continue;
    }
    if (before.includes('Warm launcher for Central') || before.includes(MARKER)) {
      counts.codex++;
      if (!before.includes(MARKER)) {
        const prefix = '/*' + MARKER + '*/\n(function(){const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");if(process.env.NLC_NODE_CORE_CLIENT_BYPASS==="1")return;const cfg=' + JSON.stringify(options('codex')) + ';let mode;try{mode=JSON.parse(fs.readFileSync(path.join(cfg.stateRoot,"central-bridge.json"),"utf8")).mode;}catch{return;}if(mode!=="node"||!fs.existsSync(cfg.executable))return;const input=fs.readFileSync(0);const reply=' + expression('codex') + ';if(reply!==null){process.stdout.write(reply);process.exit(0);}const old=cp.spawnSync(process.execPath,[__filename],{input,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,env:{...process.env,NLC_NODE_CORE_CLIENT_BYPASS:"1"}});if(old.stdout)process.stdout.write(old.stdout);process.exit(old.status===null?1:old.status);})();\n';
        originals.push({ file: warm, runtime: 'codex', before });
        writes.push({ file: warm, body: before.replace("'use strict';", "'use strict';\n" + prefix) });
      }
    }
  }
  if (!counts.claude && !counts.codex) return { ok: false, message: 'No supported existing Central caller was found. The existing bridge remains selected.', counts };
  fs.mkdirSync(stateRoot, { recursive: true });
  if (originals.length) {
    const backup = path.join(stateRoot, 'central-caller-before.json');
    let saved = []; try { saved = JSON.parse(fs.readFileSync(backup, 'utf8')); } catch {}
    fs.writeFileSync(backup, JSON.stringify([...saved, ...originals], null, 2), { mode: 0o600 });
  }
  for (const write of writes) {
    const temporary = write.file + '.node-core.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, write.body, { mode: 0o600 }); fs.renameSync(temporary, write.file);
  }
  return { ok: true, counts, changedFiles: writes.map(write => write.file), message: 'Existing Central callers are attached. The shared node/legacy switch selects their path.' };
}
module.exports = { configureCentralClients, MARKER };
