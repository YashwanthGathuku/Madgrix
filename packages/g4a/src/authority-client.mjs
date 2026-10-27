// Client side of the phase-2 authority: locate the authority for a repo and talk to it.
//   system mode: /etc/g4a/authority.json (root-owned) maps repo id -> {id, root, pub}; every call
//                goes through `sudo -n -u g4a-authority /usr/local/lib/g4a/bin/<wrapper>` (the
//                sudoers rule allows ONLY those root-owned wrappers). Takes precedence over git
//                config, so an agent cannot "downgrade" the repo to same-user mode.
//   user mode:   git config g4a.authority=DIR (same uid; DETECT-ONLY fallback).
import fs from 'node:fs';
import { redact } from './privacy.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { repoId } from './authority.mjs';
import { CLIENT_ANCHOR_REF, AUTH_ANCHOR_REF } from './authority-service.mjs';

export const SYSTEM_MAP = process.env.G4A_SYSTEM_MAP_TEST || '/etc/g4a/authority.json';
export const SYSTEM_USER = 'g4a-authority';
export const LIB = '/usr/local/lib/g4a';
export const WRAP = (n) => `${LIB}/bin/${n}`;
const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'authority-service.mjs');
const PROTO = ['-c', 'protocol.file.allow=always'];

export function readSystemMap() { try { return JSON.parse(fs.readFileSync(SYSTEM_MAP, 'utf8')); } catch { return {}; } }

export function locate(repoPath) {
  let id;
  try { id = repoId(repoPath); } catch { return null; }
  const sys = readSystemMap()[id];
  if (sys) return { mode: 'system', repo: id, id: sys.id, root: sys.root, pub: sys.pub, url: path.join(sys.root, 'repo'), anchors: path.join(sys.root, 'anchors.git') };
  const dir = safeGit(repoPath, ['config', '--get', 'g4a.authority'], { allowFailure: true }).stdout.trim();
  if (!dir) return null;
  const root = path.resolve(dir);
  return { mode: 'user', repo: id, root, pub: path.join(root, 'pub'), url: path.join(root, 'repo'), anchors: path.join(root, 'anchors.git') };
}

export function call(loc, cmd, params = {}, { interactive = false } = {}) {
  const { credential, ...rest } = params;
  const b64 = Buffer.from(JSON.stringify(credential ? { ...rest, credential_stdin: true } : rest)).toString('base64');
  const argv = loc.mode === 'system'
    ? ['sudo', ['-n', '-u', SYSTEM_USER, WRAP('g4a-authority'), loc.id, cmd, b64]]
    : [process.execPath, ['--no-warnings', SERVICE, '--root', loc.root, cmd, b64]];
  const r = spawnSync(argv[0], argv[1], { encoding: 'utf8', ...(credential ? { input: credential + '\n' } : {}), stdio: [credential ? 'pipe' : 'ignore', 'pipe', interactive ? 'inherit' : 'pipe'], maxBuffer: 256 << 20 });
  const line = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { ok: false, error: redact(`authority call failed (exit ${r.status}): ${(r.stderr || '').trim().split('\n').slice(-2).join(' ') || line}`) }; }
}

export const receivePack = (loc) => (loc.mode === 'system' ? `sudo -n -u ${SYSTEM_USER} ${WRAP('g4a-receive-pack')}` : null);
export const uploadPack = (loc) => (loc.mode === 'system' ? `sudo -n -u ${SYSTEM_USER} ${WRAP('g4a-upload-pack')}` : null);
const packArgs = (loc, kind) => { const v = kind === 'r' ? receivePack(loc) : uploadPack(loc); return v ? [`--${kind === 'r' ? 'receive' : 'upload'}-pack=${v}`] : []; };

// push the agent branch with a fresh one-time permit to refs/heads/agents/<agent>
export function pushAgent(loc, worktree, agent, sha, credential) {
  const pr = call(loc, 'permit', { agent, credential });
  if (!pr.ok) return pr;
  const r = safeGit(worktree, [...PROTO, 'push', '--quiet', '--porcelain', '-o', `permit=${pr.permit}`, ...packArgs(loc, 'r'), loc.url, `${sha}:refs/heads/agents/${agent}`], { allowFailure: true });
  if (r.status !== 0) return { ok: false, error: redact(`authority refused the push: ${(r.stderr || '').split('\n').filter((l) => /refused|error/.test(l)).join(' ').trim() || `exit ${r.status}`}`) };
  return { ok: true };
}

// fetch authority main into a scratch ref of `repo`; returns its sha
export function fetchMain(loc, repo) {
  const r = safeGit(repo, [...PROTO, 'fetch', '--quiet', '--no-tags', ...packArgs(loc, 'u'), loc.url, '+refs/heads/main:refs/g4a/authority-main'], { allowFailure: true });
  if (r.status !== 0) throw new Error(`fetch from authority failed: ${r.stderr.trim()}`);
  return safeGit(repo, ['rev-parse', 'refs/g4a/authority-main']).stdout.trim();
}

// an agent OS user (g4a run --agent) anchors its own ledger under its own ref; the anchor hook
// only lets the bound uid write it, so agents cannot clobber each other's anchor chains
const clientRef = (loc) => (loc.mode === 'system' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(process.env.G4A_AGENT_NAME || '') ? `${CLIENT_ANCHOR_REF}s/${process.env.G4A_AGENT_NAME}` : CLIENT_ANCHOR_REF);
export const clientAnchorRemote = (loc) => ({ url: loc.anchors, ref: clientRef(loc), receivePack: receivePack(loc), uploadPack: uploadPack(loc) });
export const authorityAnchorRemote = (loc) => ({ url: loc.anchors, ref: AUTH_ANCHOR_REF, uploadPack: uploadPack(loc) });
export const pubFile = (loc, name) => path.join(loc.pub, name);
