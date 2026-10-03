#!/usr/bin/env bash
# Rebase a contender's candidate onto a moved destination head and push the
# result to the contender's fork as a new commit
# (specs/amendments/rebase-ancestry-v1.md). The rebased commit is a NEW
# candidate: the task authority records the rebase, and the commit must be
# evaluated again before any permit can name it. Nothing here touches the
# destination.
#
# Environment: OP_ID (hex), FORK_REMOTE, FORK_TOKEN, CANDIDATE_SHA,
# DESTINATION_REMOTE, DESTINATION_TOKEN, ONTO (the destination head).
#
# Output: KEY=value lines on stdout, and the exit status:
#   0  OUTCOME=REBASED, REBASED_SHA (pushed to the fork's main), ONTO
#   0  OUTCOME=UP_TO_DATE, REBASED_SHA (= CANDIDATE_SHA; nothing pushed), ONTO
#   42 OUTCOME=FORK_MOVED, FORK_HEAD    the fork's main is not the candidate
#   44 OUTCOME=PUSH_REJECTED            the fork refused the push (or moved during it)
#   45 the fetched ONTO is not ONTO
#   48 OUTCOME=ALREADY_IN_DESTINATION, ONTO   ONTO already holds the candidate's changes
#   49 OUTCOME=CONFLICT, ONTO, CONFLICT_PATHS (base64 of the NUL-terminated
#      conflicting paths: any byte a path may hold survives)
#   anything else: a git failure (retryable)
# src/lib/git-promotion.ts models this script step for step; the two are
# held together by test/fixtures/promotion-cases.json.
set -euo pipefail

case "$OP_ID" in
  '' | *[!0-9a-f]*) echo "OP_ID must be lowercase hex" >&2; exit 2 ;;
esac

WORK="${TMPDIR:-/tmp}/madgrix-rebase-${OP_ID}"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

# A fixed committer and committer dates taken from the author dates make
# the rebase deterministic: the same candidate rebased onto the same head is
# the same commit. Attributes are read from the empty tree, never from the
# candidate's own .gitattributes, so a candidate cannot choose merge drivers
# (merge=union) that turn a conflict into a silent merge.
export GIT_COMMITTER_NAME="madgrix-rebase"
export GIT_COMMITTER_EMAIL="rebase@madgrix.invalid"
export GIT_ATTR_SOURCE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
LOG_PATH=".madgrix/tool-status.jsonl"

git init -q
git remote add fork "$FORK_REMOTE"
git remote add destination "$DESTINATION_REMOTE"

git -c "http.extraHeader=Authorization: Bearer $FORK_TOKEN" fetch -q --no-tags fork main
FORK_HEAD="$(git rev-parse FETCH_HEAD)"
if [ "$FORK_HEAD" != "$CANDIDATE_SHA" ]; then
  printf 'OUTCOME=FORK_MOVED\nFORK_HEAD=%s\n' "$FORK_HEAD"
  exit 42
fi

git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" fetch -q --no-tags destination "$ONTO"
if [ "$(git rev-parse FETCH_HEAD)" != "$ONTO" ]; then
  echo "onto SHA mismatch" >&2
  exit 45
fi

if git merge-base --is-ancestor "$CANDIDATE_SHA" "$ONTO"; then
  printf 'OUTCOME=ALREADY_IN_DESTINATION\nONTO=%s\n' "$ONTO"
  exit 48
fi
if git merge-base --is-ancestor "$ONTO" "$CANDIDATE_SHA"; then
  printf 'OUTCOME=UP_TO_DATE\nREBASED_SHA=%s\nONTO=%s\n' "$CANDIDATE_SHA" "$ONTO"
  exit 0
fi

conflicts_b64() {
  git diff --name-only --diff-filter=U -z | base64 | tr -d '\n'
}
LOG_ONLY_B64="$(printf '%s\0' "$LOG_PATH" | base64 | tr -d '\n')"

git checkout -q --detach "$CANDIDATE_SHA"
set +e
git rebase -q --committer-date-is-author-date "$ONTO" >/dev/null 2>&1
STATUS=$?
set -e
while [ "$STATUS" -ne 0 ]; do
  if [ ! -d "$(git rev-parse --git-path rebase-merge)" ]; then
    echo "git rebase failed" >&2
    exit "$STATUS"
  fi
  CONFLICTS="$(conflicts_b64)"
  if [ -z "$CONFLICTS" ]; then
    git rebase --abort
    echo "git rebase stopped without a conflict" >&2
    exit 1
  fi
  if [ "$CONFLICTS" != "$LOG_ONLY_B64" ]; then
    printf 'OUTCOME=CONFLICT\nONTO=%s\nCONFLICT_PATHS=%s\n' "$ONTO" "$CONFLICTS"
    git rebase --abort
    exit 49
  fi
  # Only the tool-status log conflicts. It is the contender's own receipt
  # for this candidate (specs/amendments/tool-status-v1.md), and the
  # destination's copy belongs to an earlier promotion: keep the
  # candidate's version, or its deletion.
  if git checkout -q --theirs -- "$LOG_PATH" 2>/dev/null; then
    git add -- "$LOG_PATH"
  else
    git rm -q --cached --ignore-unmatch -- "$LOG_PATH"
    rm -f -- "$LOG_PATH"
  fi
  set +e
  GIT_EDITOR=true git rebase --continue >/dev/null 2>&1
  STATUS=$?
  set -e
done
REBASED_SHA="$(git rev-parse HEAD)"

# Every change of the candidate was already in ONTO: nothing is left to
# rebase or promote.
if [ "$REBASED_SHA" = "$ONTO" ]; then
  printf 'OUTCOME=ALREADY_IN_DESTINATION\nONTO=%s\n' "$ONTO"
  exit 48
fi

# Compare-and-swap on the fork: replace the candidate and nothing newer.
if ! git -c "http.extraHeader=Authorization: Bearer $FORK_TOKEN" push -q \
  --force-with-lease="refs/heads/main:$CANDIDATE_SHA" fork "$REBASED_SHA:refs/heads/main"; then
  printf 'OUTCOME=PUSH_REJECTED\n'
  exit 44
fi

printf 'OUTCOME=REBASED\nREBASED_SHA=%s\nONTO=%s\n' "$REBASED_SHA" "$ONTO"
