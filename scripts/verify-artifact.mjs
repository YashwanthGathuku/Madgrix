// @ts-nocheck -- merged from competition/artifact-verifier, which was written without strict checkJs; behavior unchanged.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AUTH = 'https://seam.dev/AgentPromotionAuthority/v1';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_OBJECT = 32 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
}
function git(repo, args, maxBuffer = MAX_OBJECT + 8192) {
  return execFileSync('git', ['--no-replace-objects', '-C', repo, ...args], {
    env: environment(), timeout: 15000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function text(repo, args) { return git(repo, args).toString('utf8').trim(); }

export function inspectGitArtifact(repo, commit) {
  if (!OID.test(commit)) throw new Error('commit must be a full lowercase Git object ID');
  const format = text(repo, ['rev-parse', '--show-object-format']);
  if (!['sha1', 'sha256'].includes(format)) throw new Error('unsupported object format');
  if (commit.length !== (format === 'sha1' ? 40 : 64)) throw new Error('object format mismatch');
  if (text(repo, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('shallow repositories unsupported');
  const grafts = text(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']);
  if (existsSync(grafts) && readFileSync(grafts).toString().trim()) throw new Error('legacy grafts unsupported');
  const cache = new Map();
  function object(type, oid) {
    if (!OID.test(oid)) throw new Error('invalid referenced object ID');
    const key = type + ':' + oid;
    if (cache.has(key)) return cache.get(key);
    const bytes = git(repo, ['cat-file', type, oid]);
    if (bytes.length > MAX_OBJECT) throw new Error('object size limit exceeded');
    const actual = createHash(format).update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest('hex');
    if (actual !== oid) throw new Error('object content hash mismatch');
    cache.set(key, bytes);
    return bytes;
  }
  const raw = object('commit', commit).toString('utf8');
  const rootTree = raw.split('\n').find(x => x.startsWith('tree '))?.slice(5);
  if (!rootTree || !OID.test(rootTree)) throw new Error('invalid commit tree');
  object('tree', rootTree);
  const listing = git(repo, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit], 8 * 1024 * 1024);
  const records = listing.length ? listing.subarray(0, listing.at(-1) === 0 ? listing.length - 1 : listing.length).toString('binary').split('\0') : [];
  if (records.length > 10000) throw new Error('tree entry limit exceeded');
  const entries = [];
  let totalBytes = 0;
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('malformed tree entry');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const path = decoder.decode(Buffer.from(record.slice(tab + 1), 'binary'));
    if (type === 'tree' && mode === '040000') { object('tree', oid); continue; }
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) throw new Error('unsupported tree entry: ' + path);
    const bytes = object('blob', oid);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL) throw new Error('total artifact size limit exceeded');
    entries.push({ mode, type, path, bytes });
  }
  return { commit, rootTree, entries, totalBytes, parent: raw.split('\n').find(x => x.startsWith('parent '))?.slice(7) ?? '' };
}

export async function verifyArtifact(input, deps) {
  const checks = [];
  function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail });
    if (!ok) throw new Error(detail || name);
  }
  try {
    check('receiver expectations', typeof input.expectedDestination === 'string' && input.expectedDestination.length > 0 && DIGEST.test(input.expectedPolicyHash) && OID.test(input.expectedBase), 'explicit destination, policy SHA-256 and full base ID required');
    const evidence = await deps.verifyEvidence(input.bundle);
    check('signed evidence', evidence?.verified === true, 'pinned-key evidence verifier rejected bundle');
    const b = input.bundle;
    check('bundle version', b?.version === 3, 'only bundle version 3 supported');
    const statements = b.statements.map(e => JSON.parse(e.payload));
    const authorities = statements.filter(s => s.predicateType === AUTH);
    check('unique authority', authorities.length === 1, 'exactly one signed authority required');
    const a = authorities[0].predicate;
    check('destination', a.destination.repo === input.expectedDestination && b.ship.repo === input.expectedDestination, 'destination differs from receiver expectation');
    check('required policy', a.verification.policy_sha256 === input.expectedPolicyHash && a.verification.result === 'PASSED', 'policy/result differs from receiver expectation');
    check('destination base', a.destination.base === input.expectedBase && b.ship.base === input.expectedBase, 'base differs from receiver expectation');
    check('exact commit', input.commit === a.candidate.commit && input.commit === b.ship.commit, 'requested commit differs from signed candidate/ship');
    const tests = statements.filter(s => s.predicateType === 'https://in-toto.io/attestation/test-result/v1');
    const verifications = statements.filter(s => s.predicateType === 'https://in-toto.io/attestation/verification-result/v1');
    check('passing result identity', tests.length === 1 && verifications.length === 1 && tests[0].predicate.result === 'PASS' && tests[0].predicate.artifact.commit === input.commit && verifications[0].predicate.artifact.commit === input.commit, 'unique passing test and verification must name the actual commit');
    const actual = inspectGitArtifact(input.repo, input.commit);
    const digest = await deps.treeDigest(actual.entries);
    check('actual tree digest', digest?.ok === true && digest.digest === a.candidate.tree_sha256 && digest.digest === b.ship.tree_sha256, 'actual committed bytes/modes/paths differ from signed tree-digest/v1');
    for (const [name, base] of [['destination ancestry', input.expectedBase], ['baseline ancestry', a.baseline.git_commit]]) {
      check(name + ' input', OID.test(base), 'invalid baseline ID');
      git(input.repo, ['merge-base', '--is-ancestor', base, input.commit]);
      check(name, true, 'actual ancestry matches');
    }
    check('first parent', actual.parent === b.ship.parent, 'actual first parent differs from ship record');
    return { acceptable: true, checks, actual: { commit: actual.commit, gitTree: actual.rootTree, treeDigest: digest.digest, blobs: actual.entries.length, bytes: actual.totalBytes }, testsRerun: false, remoteStateChecked: false, workingTreeChecked: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!checks.some(c => !c.ok)) checks.push({ name: 'artifact verification', ok: false, detail: error });
    return { acceptable: false, checks, error, testsRerun: false, remoteStateChecked: false, workingTreeChecked: false };
  }
}

const USAGE = 'node scripts/verify-artifact.mjs --repo PATH --commit FULL_SHA --bundle FILE --trust-key FILE --expected-destination ID --expected-policy SHA256 --expected-base FULL_SHA [--json]';
export function parseArguments(args) {
  const required = new Set(['--repo', '--commit', '--bundle', '--trust-key', '--expected-destination', '--expected-policy', '--expected-base']);
  const values = new Map();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (!required.has(flag) || values.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(USAGE);
    values.set(flag, args[++i]);
  }
  if ([...required].some(k => !values.has(k))) throw new Error(USAGE);
  return { values, json };
}
async function main() {
  const { values, json } = parseArguments(process.argv.slice(2));
  const [{ parseTrustedKey, verifyWithTrustedKey }, { treeDigestV1 }] = await Promise.all([
    import('../src/cli/verify.ts'), import('../src/lib/tree-digest.ts'),
  ]);
  const bundle = JSON.parse(await readFile(values.get('--bundle'), 'utf8'));
  const key = parseTrustedKey(await readFile(values.get('--trust-key'), 'utf8'));
  const result = await verifyArtifact({ repo: values.get('--repo'), commit: values.get('--commit'), bundle,
    expectedDestination: values.get('--expected-destination'), expectedPolicyHash: values.get('--expected-policy'), expectedBase: values.get('--expected-base'),
  }, { verifyEvidence: b => verifyWithTrustedKey(b, key), treeDigest: treeDigestV1 });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const c of result.checks) console.log(`${c.name.padEnd(30, '.')} ${c.ok ? 'OK' : 'FAIL'}${!c.ok ? ': ' + c.detail : ''}`);
    console.log(result.acceptable ? 'ARTIFACT ACCEPTABLE' : 'ARTIFACT REJECTED');
    console.log('Committed Git objects only. Tests, remote current state, and working tree NOT checked.');
  }
  process.exitCode = result.acceptable ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 2; });
}
