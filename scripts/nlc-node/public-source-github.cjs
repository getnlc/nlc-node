'use strict';
// The protected adapter that puts a built NLC Node public repository on GitHub. It is handed to publishVerifiedRelease as
// publicSource.adapterProvider. The credential comes only from the protected environment (NLC_NODE_PUBLIC_SOURCE_TOKEN) and
// reaches git through its environment, never its command line or a file. The repository must sit under the NLC organisation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = /^https:\/\/github\.com\/getnlc\/[A-Za-z0-9_.-]+$/;

function githubPublicSourceAdapter({ repository, environment = process.env, run = execFileSync } = {}) {
  if (!REPO.test(repository || '')) throw new Error('The public NLC Node repository must be under github.com/getnlc.');
  const token = String(environment.NLC_NODE_PUBLIC_SOURCE_TOKEN || '').trim();
  if (token.length < 20) throw new Error('Publishing the public NLC Node repository needs a protected NLC_NODE_PUBLIC_SOURCE_TOKEN.');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const env = {
    ...environment, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  const git = (cwd, ...args) => run('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    async push({ directory, version }) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-public-push-'));
      try {
        git(work, 'clone', '--quiet', '--depth', '1', repository, 'repo');
        const repo = path.join(work, 'repo');
        for (const entry of fs.readdirSync(repo)) if (entry !== '.git') fs.rmSync(path.join(repo, entry), { recursive: true, force: true });
        fs.cpSync(directory, repo, { recursive: true });
        git(repo, 'add', '-A');
        if (!String(git(repo, 'status', '--porcelain')).trim()) return { pushed: false, reason: 'unchanged' };
        git(repo, '-c', 'user.name=NLC', '-c', 'user.email=noreply@users.noreply.github.com', 'commit', '--quiet', '-m', `NLC Node ${version || 'release'}`);
        git(repo, 'push', '--quiet', 'origin', 'HEAD');
        return { pushed: true, commit: String(git(repo, 'rev-parse', 'HEAD')).trim(), repository };
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
    },
  };
}

module.exports = { githubPublicSourceAdapter };
