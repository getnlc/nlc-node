import {
  BAD_CODE_MESSAGE, NODE_AGENT_TOOLS, NodeCommandError, NodePairingError, OFFLINE_MESSAGE,
} from './node-backend.js';
import { configuredOrigin, requestOrigin } from './node-origin.js';
import { NODE_LIST_PURPOSE, NODE_DECIDE_PURPOSE } from './central-pair-pass.js';

// Routes for the customer's own computer ("NLC Node"): pairing, key refresh, disconnect, the
// dashboard's machine list, and the loopback routes the nlc-node MCP server calls.

const BAD_PAUSE_MESSAGE = 'Say whether to pause file access: paused true or false.';

function parseSwitch(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on', 'pause', 'paused', '1'].includes(text)) return true;
  if (['false', 'no', 'off', 'resume', 'resumed', 'running', '0'].includes(text)) return false;
  return null;
}

function bearer(request) {
  const header = request.headers.authorization || '';
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function ownerIdFor(request) {
  const a = request.auth || {};
  return String(a.userId ?? a.sub ?? a.id ?? a.username ?? 'owner');
}

function clientIp(request) {
  return request.ip || request.connection?.remoteAddress || 'unknown';
}

function describe(error) {
  return error instanceof NodeCommandError
    ? { code: error.code, message: error.message }
    : { code: 'BUSY', message: 'The computer could not finish that. Try again in a moment.' };
}

export function registerNodePairingRoutes({
  app,
  backend,
  authenticateRequest,
  isLocalRequest,
  exchangeLimitPerMinute = 5,
  publicOrigin,
  env = process.env,
  verifyCentralPass,
} = {}) {
  if (!app || !backend || !authenticateRequest || !isLocalRequest) {
    throw new Error('Node pairing routes need their app, backend, dashboard sign-in check and local-request check.');
  }
  const attempts = new Map();

  // The address the customer reaches their dashboard on (the connection link is built from it). The agent's
  // requests come in on the loopback address, so the last address a signed-in dashboard used stands in for it.
  let lastDashboardOrigin = '';
  function dashboardOrigin(request) {
    const found = configuredOrigin(publicOrigin, env) || requestOrigin(request);
    if (found) lastDashboardOrigin = found;
    return found;
  }
  const linkFor = (origin, code) => (origin ? `${origin}/n/${code}` : undefined);

  // ---- Dashboard side (signed-in customer) ----
  app.post('/api/node/pair/code', (request, response) => {
    if (!authenticateRequest(request, response)) return;
    const created = backend.createPairingCode(ownerIdFor(request));
    const link = linkFor(dashboardOrigin(request), created.code);
    response.json({ ...created, ...(link ? { link } : {}) });
  });

  // ---- A computer asks to link (no code), the owner presses Allow in NLC Central ----
  // The request is kept here on the server; Central lists and decides with signed, one-use, one-minute requests.
  const requestTries = new Map();
  function rateLimited(request, response, limit) {
    const ip = clientIp(request); const nowMs = Date.now();
    let entry = requestTries.get(ip);
    if (!entry || entry.resetAt < nowMs) { entry = { count: 0, resetAt: nowMs + 60_000 }; requestTries.set(ip, entry); }
    entry.count += 1;
    if (entry.count > limit) { response.status(429).json({ error: 'Too many tries. Wait a minute and try again.' }); return true; }
    return false;
  }

  app.post('/api/node/pair/request', (request, response) => {
    if (rateLimited(request, response, 30)) return;
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      response.json(backend.requestLink({ machineName: body.machineName, os: body.os, version: body.version }));
    } catch (error) {
      if (error instanceof NodePairingError) return response.status(400).json({ error: error.message });
      response.status(500).json({ error: 'This NLC could not take that request. Try again in a moment.' });
    }
  });

  app.post('/api/node/pair/request/status', (request, response) => {
    if (rateLimited(request, response, 120)) return;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    response.json(backend.requestStatus(body.requestId, body.secret));
  });

  async function centralChecked(request, response, purpose) {
    if (typeof verifyCentralPass !== 'function') {
      response.status(404).json({ error: 'This NLC does not take these requests from NLC Central.' });
      return null;
    }
    if (rateLimited(request, response, 120)) return null;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    let checked;
    try { checked = await verifyCentralPass(String(body.pass ?? ''), purpose); } catch { checked = { ok: false, status: 503, message: 'This NLC could not check that request. Try again in a moment.' }; }
    if (!checked.ok) { response.status(checked.status || 401).json({ error: checked.message }); return null; }
    return body;
  }

  app.post('/api/node/pair/pending', async (request, response) => {
    if (!(await centralChecked(request, response, NODE_LIST_PURPOSE))) return;
    response.json({ pending: backend.listPending(), linked: backend.listAllMachines() });
  });

  app.post('/api/node/pair/decide', async (request, response) => {
    const body = await centralChecked(request, response, NODE_DECIDE_PURPOSE);
    if (!body) return;
    try {
      if (body.decision === 'unlink') {
        if (!backend.removeMachine(String(body.machineId || ''))) return response.status(404).json({ error: 'That computer is not on your list.' });
        return response.json({ ok: true, state: 'unlinked' });
      }
      response.json({ ok: true, ...backend.decideRequest(body.id, body.decision) });
    } catch (error) {
      if (error instanceof NodePairingError) return response.status(404).json({ error: error.message });
      response.status(500).json({ error: 'This NLC could not do that. Try again in a moment.' });
    }
  });

  app.get('/api/node/machines', (request, response) => {
    if (!authenticateRequest(request, response)) return;
    const owner = ownerIdFor(request);
    const origin = dashboardOrigin(request);
    const pairing = backend.activePairing(owner);
    const link = pairing ? linkFor(origin, pairing.code) : undefined;
    response.json({ machines: backend.listMachines(owner), ...(pairing ? { pairing: { ...pairing, ...(link ? { link } : {}) } } : {}) });
  });

  function ownedMachine(request, response) {
    const machine = backend.getMachine(String(request.params.machineId || ''));
    if (!machine || machine.ownerId !== ownerIdFor(request)) {
      response.status(404).json({ error: 'That computer is not on your list.' });
      return null;
    }
    return machine;
  }

  app.delete('/api/node/machines/:machineId', (request, response) => {
    if (!authenticateRequest(request, response)) return;
    const machine = ownedMachine(request, response);
    if (!machine) return;
    backend.removeMachine(machine.machineId);
    response.json({ ok: true });
  });

  app.post('/api/node/machines/:machineId/pause', async (request, response) => {
    if (!authenticateRequest(request, response)) return;
    const machine = ownedMachine(request, response);
    if (!machine) return;
    const paused = parseSwitch(request.body?.paused);
    if (paused === null) return response.status(400).json({ error: BAD_PAUSE_MESSAGE });
    try {
      response.json({ ok: true, ...(await backend.setPaused(machine.machineId, paused)) });
    } catch (error) {
      const info = describe(error);
      response.status(info.code === 'OFFLINE' ? 409 : 502).json({ error: info.message });
    }
  });

  // ---- Customer's computer side ----
  app.post('/api/node/pair/exchange', (request, response) => {
    const ip = clientIp(request);
    const nowMs = Date.now();
    let entry = attempts.get(ip);
    if (!entry || entry.resetAt < nowMs) { entry = { count: 0, resetAt: nowMs + 60_000 }; attempts.set(ip, entry); }
    entry.count += 1;
    if (entry.count > exchangeLimitPerMinute) {
      return response.status(429).json({ error: 'Too many tries. Wait a minute and try again.' });
    }
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      response.json(backend.exchangeCode({
        code: body.code, machineName: body.machineName, os: body.os, version: body.version,
      }));
    } catch (error) {
      if (error instanceof NodePairingError) return response.status(400).json({ error: error.message });
      response.status(400).json({ error: BAD_CODE_MESSAGE });
    }
  });

  app.post('/api/node/refresh', (request, response) => {
    const result = backend.refreshToken(bearer(request));
    if (!result) return response.status(401).json({ error: 'This computer is not paired any more. Ask your assistant for a new code.' });
    response.json(result);
  });

  app.post('/api/node/disconnect', (request, response) => {
    const machine = backend.authenticateToken(bearer(request));
    if (!machine) return response.status(401).json({ error: 'This computer is not paired any more.' });
    backend.removeMachine(machine.machineId);
    response.json({ ok: true });
  });

  // ---- Agent side: loopback only, same rule as /api/browser/agent ----
  function localOnly(request, response) {
    if (isLocalRequest(request)) return true;
    response.status(403).json({ error: 'Forbidden' });
    return false;
  }

  app.get('/api/node/agent/machines', (request, response) => {
    if (!localOnly(request, response)) return;
    response.json({ machines: backend.listMachines() });
  });

  // The agent asks for a one-time code itself. The code shows up in the customer's "My computer" area at once.
  app.post('/api/node/agent/pairing-code', (request, response) => {
    if (!localOnly(request, response)) return;
    const created = backend.createPairingCode(null, { shared: true });
    const link = linkFor(configuredOrigin(publicOrigin, env) || lastDashboardOrigin, created.code);
    const steps = [
      'Tell the customer to open the My computer area on their dashboard (Settings, then Connections). It has a button to download NLC Node and shows the code and connection link.',
      link
        ? `On their Windows or Mac computer they open NLC Node and paste this connection link: ${link}`
        : `On their Windows or Mac computer they open NLC Node and paste the connection link shown in the My computer area, or type the code ${created.code}.`,
      'The code works once and for 10 minutes. If it runs out, ask for a new one.',
    ];
    response.json({ code: created.code, expiresAt: created.expiresAt, ...(link ? { link } : {}), steps });
  });

  app.post('/api/node/agent/command', async (request, response) => {
    if (!localOnly(request, response)) return;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const tool = String(body.tool ?? '').trim().toLowerCase();
    if (!NODE_AGENT_TOOLS.includes(tool)) {
      return response.status(400).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: `That tool does not exist. Available tools: ${NODE_AGENT_TOOLS.join(', ')}.` },
      });
    }
    const args = body.args === undefined || body.args === null ? {} : body.args;
    if (typeof args !== 'object' || Array.isArray(args)) {
      return response.status(400).json({ ok: false, error: { code: 'NOT_FOUND', message: 'The arguments must be an object.' } });
    }
    const all = backend.listMachines();
    const names = all.map((m) => m.name).join(', ');
    let target = null;
    const wanted = String(body.machineId ?? body.machine ?? '').trim();
    if (wanted) {
      const exact = all.find((m) => m.machineId === wanted);
      const matches = all.filter((m) => m.name.toLowerCase() === wanted.toLowerCase());
      const live = matches.filter((m) => m.connected);
      if (!exact && live.length > 1) {
        return response.json({ ok: false, error: { code: 'AMBIGUOUS', message: 'Several connected computers have that name. Choose the exact computer ID from computer_status.' } });
      }
      target = exact || live[0] || matches[0];
      if (!target) {
        return response.json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `No computer is called "${wanted}". Computers: ${names || 'none paired yet'}.` },
        });
      }
    } else {
      const live = all.filter((m) => m.connected);
      if (live.length === 1) target = live[0];
      else if (live.length > 1) {
        return response.json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Which computer? Connected computers: ${live.map((m) => m.name).join(', ')}.` },
        });
      } else if (all.length === 1) target = all[0];
      else {
        return response.json({ ok: false, error: { code: 'OFFLINE', message: OFFLINE_MESSAGE } });
      }
    }
    try {
      const result = await backend.sendCommand(target.machineId, tool, args);
      response.json({ ok: true, result });
    } catch (error) {
      response.json({ ok: false, error: describe(error) });
    }
  });
}
