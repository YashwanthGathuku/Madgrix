#!/usr/bin/env bash
# Full CLI end-to-end for g4a Phase 2, using the real bin/g4a.mjs. Local only (no network).
#  part A: same-user authority (detect-only): 3 agents, overlap -> REVIEW, disjoint -> promoted, verify + audit
#  part B: system authority (separate OS user; needs passwordless sudo): 2 agents promoted via
#          sudo wrappers, verify + audit, then the non-sudo agent-user bypass attempts (test/system.test.mjs)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
CLI="$HERE/bin/g4a.mjs"
W=$(mktemp -d /tmp/g4a-e2e-XXXXXX); chmod 755 "$W"
export G4A_HOME="$W/home" G4A_KEY_DIR="$W/keys" GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local
unset G4A_LOCAL_LAND
g4a() { node --no-warnings "$CLI" "$@" || true; } # judge by JSON fields, not exit codes
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(process.argv[1].split(".").reduce((a,k)=>a?.[k],o))})' "$1"; }
fail() { echo "E2E FAIL: $*" >&2; exit 1; }
RBID=""
cleanup() {
  g4a stop >/dev/null 2>&1 || true
  # self-clean the system authority for this run's repo (removes the whole install if no other repo uses it)
  [ -n "$RBID" ] && g4a authority uninstall --system --repo-id "$RBID" >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT

mkrepo() {
  mkdir -p "$1/test" && cd "$1" && git init -q -b main
  printf 'export function add(a, b) {\n  return a + b;\n}\n' > add.js
  echo b > b.txt; echo c > c.txt
  echo '{"type":"module","scripts":{"test":"node --test"}}' > package.json
  echo 'import test from "node:test"; import assert from "node:assert"; import { add } from "../add.js"; test("add", () => assert.equal(add(1, 2), 3));' > test/add.test.mjs
  git add -A && G4A_RAW=1 git commit -qm base && git checkout -q --detach; cd - >/dev/null
}
edit() { (cd "$1/.g4a/worktrees/$2" && eval "$3" && git add -A && G4A_RAW=1 git commit -qm "$2 edit"); }

g4a daemon --detach >/dev/null; sleep 1

echo "== A: same-user authority =="
mkrepo "$W/ra"
g4a authority init "$W/auth-a" --repo "$W/ra" | field note
for a in a1 a2; do g4a claim --repo "$W/ra" --agent $a --paths add.js --witness 'npm test' --allow-overlap | field ok | grep -qx true || fail "claim $a"; done
g4a claim --repo "$W/ra" --agent a3 --paths c.txt --witness 'npm test' | field ok | grep -qx true || fail "claim a3"
g4a claim --repo "$W/ra" --agent a4 --paths c.txt --witness true | field ok | grep -qx false || fail "overlapping claim a4 must be refused"
edit "$W/ra" a1 "sed -i 's/a + b/a + b + 0/' add.js"
edit "$W/ra" a2 "sed -i 's/a + b/Number(a) + Number(b)/' add.js"
edit "$W/ra" a3 "echo C > c.txt"
[ "$(g4a promote --repo "$W/ra" --agent a1 | field status)" = promoted ] || fail "a1 promote"
[ "$(g4a promote --repo "$W/ra" --agent a3 | field status)" = promoted ] || fail "a3 promote"
[ "$(g4a promote --repo "$W/ra" --agent a2 | field status)" = review ] || fail "a2 must go to review"
[ "$(g4a verify --repo "$W/ra" | field ok)" = true ] || fail "verify A"
[ "$(g4a authority audit --repo "$W/ra" | field ok)" = true ] || fail "audit A"
[ "$(git -C "$W/ra" rev-parse main)" = "$(git -C "$W/auth-a/repo" rev-parse main)" ] || fail "main sync A"
echo "A ok: 2 promoted, 1 review, 1 overlapping claim refused, verify+audit ok"

if sudo -n true 2>/dev/null; then
  echo "== B: system authority (g4a-authority OS user) =="
  mkrepo "$W/rb"
  RBID=$(cd "$W/rb" && git rev-parse --path-format=absolute --git-common-dir | xargs realpath)
  g4a authority init --system --repo "$W/rb" | field mode | grep -qx system || fail "init --system"
  g4a claim --repo "$W/rb" --agent s1 --paths add.js --witness 'npm test' | field ok | grep -qx true || fail "claim s1"
  g4a claim --repo "$W/rb" --agent s2 --paths b.txt --witness 'npm test' | field ok | grep -qx true || fail "claim s2"
  edit "$W/rb" s1 "sed -i 's/a + b/b + a/' add.js"
  edit "$W/rb" s2 "echo B > b.txt"
  for a in s1 s2; do r=$(g4a promote --repo "$W/rb" --agent $a); [ "$(echo "$r" | field via)" = authority:system ] && [ "$(echo "$r" | field status)" = promoted ] || fail "$a system promote: $r"; done
  [ "$(g4a verify --repo "$W/rb" | field ok)" = true ] || fail "verify B"
  [ "$(g4a authority audit --repo "$W/rb" | field ok)" = true ] || fail "audit B"
  echo "B ok: 2 promoted via sudo wrappers, verify+audit ok; now agent-user bypass attempts:"
  (cd "$HERE" && node --test test/system.test.mjs) | grep -E '^# (pass|fail)'
  (cd "$HERE" && node --test test/system.test.mjs) | grep -qx '# fail 0' || fail "system separation test"
else
  echo "== B skipped: no passwordless sudo (system authority not exercised) =="
fi
echo "E2E PASS"
