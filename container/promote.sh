#!/usr/bin/env bash
set -euo pipefail

WORK="/tmp/madgrix-${PERMIT_ID}"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

git init -q
git remote add source "$SOURCE_REMOTE"
git remote add destination "$DESTINATION_REMOTE"

git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" fetch -q --no-tags destination main
CURRENT_HEAD="$(git rev-parse FETCH_HEAD)"

git -c "http.extraHeader=Authorization: Bearer $SOURCE_TOKEN" fetch -q --no-tags source "$CANDIDATE_SHA"
FETCHED_CANDIDATE="$(git rev-parse FETCH_HEAD)"
if [ "$FETCHED_CANDIDATE" != "$CANDIDATE_SHA" ]; then
  echo "candidate SHA mismatch" >&2
  exit 45
fi

# MADGRIX tree-digest/v1:
# SHA256 over mode NUL path NUL SHA256(blob-bytes) NUL for every blob in
# recursive Git ls-tree byte order. Submodules/non-blob leaves are rejected.
TREE_DIGEST="$(
  git ls-tree -rz --full-tree "$CANDIDATE_SHA" |
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    mode="${meta%% *}"
    rest="${meta#* }"
    type="${rest%% *}"
    object="${rest##* }"
    if [ "$type" != "blob" ]; then
      echo "unsupported non-blob tree entry: $type $path" >&2
      exit 46
    fi
    blob_sha256="$(git cat-file blob "$object" | sha256sum | awk '{print $1}')"
    printf '%s\0%s\0%s\0' "$mode" "$path" "$blob_sha256"
  done | sha256sum | awk '{print $1}'
)"

if [ "$TREE_DIGEST" != "$WINNING_TREE_SHA256" ]; then
  printf 'TREE_DIGEST=%s\n' "$TREE_DIGEST"
  exit 43
fi

# Retry reconciliation: if the exact reviewed candidate is already canonical,
# the Git write succeeded previously and only authority finalization remains.
if [ "$CURRENT_HEAD" = "$CANDIDATE_SHA" ]; then
  printf 'OUTCOME=ALREADY_WRITTEN\nPROMOTED_SHA=%s\nTREE_DIGEST=%s\nPARENT=%s\n' "$CANDIDATE_SHA" "$TREE_DIGEST" "$EXPECTED_HEAD"
  exit 0
fi

if [ "$CURRENT_HEAD" != "$EXPECTED_HEAD" ]; then
  printf 'OUTCOME=EXPIRED_HEAD_MOVED\nCURRENT_HEAD=%s\n' "$CURRENT_HEAD"
  exit 42
fi

# The reviewed commit itself must descend from the exact destination state
# bound into the permit. This preserves candidate Git identity bit-for-bit.
if ! git merge-base --is-ancestor "$EXPECTED_HEAD" "$CANDIDATE_SHA"; then
  printf 'OUTCOME=BASELINE_MISMATCH\n'
  exit 47
fi

# Final compare-and-swap. A concurrent destination advance makes this
# non-fast-forward push fail; no stale reviewed state can ship.
if ! git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" push -q destination "$CANDIDATE_SHA:refs/heads/main"; then
  exit 44
fi

printf 'OUTCOME=PROMOTED\nPROMOTED_SHA=%s\nTREE_DIGEST=%s\nPARENT=%s\n' "$CANDIDATE_SHA" "$TREE_DIGEST" "$EXPECTED_HEAD"
