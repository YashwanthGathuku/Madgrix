// Authority repo post-receive: runs only after git applied the updates; logs each ref whose current
// value is the pushed value, so the accepted log reflects reality (no pre-receive false entries).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [root] = process.argv.slice(2);
const lines = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
for (const l of lines) {
  const [old, nu, ref] = l.split(' ');
  const cur = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: path.join(root, 'repo'), encoding: 'utf8', env: { PATH: process.env.PATH, GIT_DIR: path.join(root, 'repo', '.git') } }).stdout.trim();
  if (cur === nu) fs.appendFileSync(path.join(root, 'accepted.jsonl'), JSON.stringify({ ref, old, new: nu, kind: 'push', at: new Date().toISOString() }) + '\n');
}
