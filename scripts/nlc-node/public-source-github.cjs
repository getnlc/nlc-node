'use strict';
// The protected adapter that puts a built NLC Node public repository on GitHub. It is handed to publishVerifiedRelease as
// publicSource.adapterProvider. It pushes over SSH with the repository's own write deploy key, a private key file that stays on
// the machine (default ~/.ssh/getnlc-nlc-node-deploy, or the file named by NLC_NODE_PUBLIC_SOURCE_KEY). The key is only ever
// named in GIT_SSH_COMMAND; its contents never pass through this process. The repository must sit under the NLC organisation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = /^https:\/\/github\.com\/(getnlc\/[A-Za-z0-9_.-]+)$/;

function deployKeyPath(environment) {
  const named = String(environment.NLC_NODE_PUBLIC_SOURCE_KEY || '').trim();
  return named || path.join(environment.HOME || os.homedir(), '.ssh', 'getnlc-nlc-node-deploy');
}

function githubPublicSourceAdapter({ repository, environment = process.env, run = execFileSync } = {}) {
  const match = REPO.exec(repository || '');
  if (!match) throw new Error('The public NLC Node repository must be under github.com/getnlc.');
  const key = deployKeyPath(environment);
  if (/["'\\\s]/.test(key)) throw new Error('The NLC_NODE_PUBLIC_SOURCE_KEY path must not contain spaces or quotes.');
  if (!fs.existsSync(key)) throw new Error(`Publishing the public NLC Node repository needs its deploy key file at ${key} (or NLC_NODE_PUBLIC_SOURCE_KEY).`);
  const remote = `ssh://github.com/${match[1]}.git`;
  const env = {
    ...environment, GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -i ${key} -o User=git -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
  };
  const git = (cwd, ...args) => run('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    async push({ directory, version }) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-public-push-'));
      try {
        git(work, 'clone', '--quiet', '--depth', '1', remote, 'repo');
        const repo = path.join(work, 'repo');
        for (const entry of fs.readdirSync(repo)) if (entry !== '.git') fs.rmSync(path.join(repo, entry), { recursive: true, force: true });
        fs.cpSync(directory, repo, { recursive: true });
        git(repo, 'add', '-A');
        if (!String(git(repo, 'status', '--porcelain')).trim()) return { pushed: false, reason: 'unchanged' };
        git(repo, '-c', 'user.name=NLC', '-c', 'user.email=nlc-node-public-source', 'commit', '--quiet', '-m', `NLC Node ${version || 'release'}`);
        git(repo, 'push', '--quiet', 'origin', 'HEAD');
        return { pushed: true, commit: String(git(repo, 'rev-parse', 'HEAD')).trim(), repository };
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
    },
  };
}

module.exports = { githubPublicSourceAdapter, deployKeyPath };
