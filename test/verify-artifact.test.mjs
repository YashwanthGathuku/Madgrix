// @ts-nocheck -- merged from competition/artifact-verifier, which was written without strict checkJs; behavior unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { inspectGitArtifact, verifyArtifact, parseArguments } from '../scripts/verify-artifact.mjs';
const AUTH='https://seam.dev/AgentPromotionAuthority/v1';
const TEST='https://in-toto.io/attestation/test-result/v1';
const VERIFICATION='https://in-toto.io/attestation/verification-result/v1';
const POLICY='a'.repeat(64);
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const {publicKey:wrongKey}=generateKeyPairSync('ed25519');
function git(repo,...args) { return execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'}}).trim(); }
function digest(entries) {
  const h=createHash('sha256');
  for(const e of [...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)))) {
    h.update(e.mode+'\0').update(e.path).update('\0'+createHash('sha256').update(e.bytes).digest('hex')+'\0');
  }
  return {ok:true,digest:h.digest('hex')};
}
function envelope(predicateType,predicate,tree) {
  const payload=JSON.stringify({_type:'https://in-toto.io/Statement/v1',subject:[{digest:{sha256:tree}}],predicateType,predicate});
  return {payloadType:'application/vnd.in-toto+json',payload,signatures:[{keyid:'test',sig:sign(null,Buffer.from(payload),privateKey).toString('base64')}]};
}
function fixture(t) {
  const repo=mkdtempSync(join(tmpdir(),'madgrix-artifact-'));t.after(()=>rmSync(repo,{recursive:true,force:true}));
  git(repo,'init','-q');writeFileSync(join(repo,'base.txt'),'baseline\n');git(repo,'add','.');git(repo,'commit','-qm','baseline');
  const base=git(repo,'rev-parse','HEAD');mkdirSync(join(repo,'nested'));
  writeFileSync(join(repo,'nested','data.bin'),Buffer.from([0,255,10,128]));
  writeFileSync(join(repo,'tab\tnewline\nfile.txt'),'π\n');writeFileSync(join(repo,'run.sh'),'#!/bin/sh\nexit 0\n');chmodSync(join(repo,'run.sh'),0o755);symlinkSync('base.txt',join(repo,'link'));
  git(repo,'add','.');git(repo,'commit','-qm','candidate');const commit=git(repo,'rev-parse','HEAD');
  const actual=inspectGitArtifact(repo,commit),tree=digest(actual.entries).digest;
  const authority={baseline:{git_commit:base},candidate:{repo:'contender',commit,tree_sha256:tree},verification:{result:'PASSED',policy_sha256:POLICY},destination:{repo:'canonical',base}};
  const bundle={version:3,statements:[envelope(AUTH,authority,tree),envelope(TEST,{result:'PASS',artifact:{commit}},tree),envelope(VERIFICATION,{result:'PASSED',artifact:{commit}},tree)],ship:{repo:'canonical',commit,tree_sha256:tree,base,parent:base}};
  return {repo,base,commit,actual,bundle,input:{repo,commit,bundle,expectedDestination:'canonical',expectedPolicyHash:POLICY,expectedBase:base}};
}
// Real signatures and Git; injected evidence dependency is narrower than production ledger verification.
function deps(key=publicKey) { return {treeDigest:async e=>digest(e),verifyEvidence:async b=>({verified:b.statements.every(e=>e.signatures.length===1&&verify(null,Buffer.from(e.payload),key,Buffer.from(e.signatures[0].sig,'base64')))})}; }
function resign(f,fn) { const a=JSON.parse(f.bundle.statements[0].payload);fn(a.predicate);f.bundle.statements[0]=envelope(AUTH,a.predicate,a.subject[0].digest.sha256); }
test('accepts actual Git blobs, binary, symlink, executable and unusual paths',async t=>{const f=fixture(t),r=await verifyArtifact(f.input,deps());assert.equal(r.acceptable,true,JSON.stringify(r));assert.equal(r.actual.blobs,5);});
test('rejects different commit',async t=>{const f=fixture(t);f.input.commit=f.base;assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects same tree with different commit',async t=>{const f=fixture(t);f.input.commit=git(f.repo,'commit-tree',f.actual.rootTree,'-p',f.base,'-m','different');assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects wrong receiver destination',async t=>{const f=fixture(t);f.input.expectedDestination='other';assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects unsigned destination substitution',async t=>{const f=fixture(t);f.bundle.ship.repo='other';assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects wrong receiver policy',async t=>{const f=fixture(t);f.input.expectedPolicyHash='d'.repeat(64);assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects wrong base',async t=>{const f=fixture(t);f.input.expectedBase=f.commit;assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects tampered signed payload',async t=>{const f=fixture(t);f.bundle.statements[0].payload+=' ';assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects wrong pinned key',async t=>{const f=fixture(t);assert.equal((await verifyArtifact(f.input,deps(wrongKey))).acceptable,false);});
test('rejects actual tree mismatch even with signed wrong digest',async t=>{const f=fixture(t);resign(f,a=>a.candidate.tree_sha256='e'.repeat(64));f.bundle.ship.tree_sha256='e'.repeat(64);assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects duplicate authority',async t=>{const f=fixture(t);f.bundle.statements.push(f.bundle.statements[0]);assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects wrong first parent',async t=>{const f=fixture(t);f.bundle.ship.parent=f.commit;assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('rejects unknown version',async t=>{const f=fixture(t);f.bundle.version=4;assert.equal((await verifyArtifact(f.input,deps())).acceptable,false);});
test('fails closed on evidence error',async t=>{const f=fixture(t),d=deps();d.verifyEvidence=async()=>{throw new Error('bad bundle')};assert.equal((await verifyArtifact(f.input,d)).acceptable,false);});
test('dirty worktree is explicitly outside committed-object scope',async t=>{const f=fixture(t);writeFileSync(join(f.repo,'base.txt'),'dirty');const r=await verifyArtifact(f.input,deps());assert.equal(r.acceptable,true);assert.equal(r.workingTreeChecked,false);});
test('ignores replacement refs',async t=>{const f=fixture(t);git(f.repo,'replace',f.commit,f.base);const r=await verifyArtifact(f.input,deps());assert.equal(r.acceptable,true,JSON.stringify(r));});
test('rejects submodules',t=>{const f=fixture(t);git(f.repo,'update-index','--add','--cacheinfo','160000,'+f.base+',sub');git(f.repo,'commit','-qm','gitlink');assert.throws(()=>inspectGitArtifact(f.repo,git(f.repo,'rev-parse','HEAD')),/unsupported tree entry/);});
test('rejects abbreviated IDs and revision expressions',t=>{const f=fixture(t);assert.throws(()=>inspectGitArtifact(f.repo,'HEAD'),/full lowercase/);});
test('rejects missing CLI expectations',()=>{assert.throws(()=>parseArguments(['--repo','.']),/expected-destination/);});
