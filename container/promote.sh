#!/usr/bin/env bash
# Fast-forward the destination's main to the reviewed candidate commit
# (spec 1 §11; specs/amendments/rebase-ancestry-v1.md). The candidate ships
# bit-for-bit: no commit is created, so the promoted SHA is the reviewed SHA.
#
# Environment: PERMIT_ID, SOURCE_REMOTE, SOURCE_TOKEN, CANDIDATE_SHA,
# DESTINATION_REMOTE, DESTINATION_TOKEN, EXPECTED_HEAD (the permit-bound
# destination head), WINNING_TREE_SHA256, ISSUED_AT.
#
# Output: KEY=value lines on stdout, and the exit status:
#   0  OUTCOME=PROMOTED or ALREADY_WRITTEN, PROMOTED_SHA, TREE_DIGEST,
#      BASE (= EXPECTED_HEAD) and PARENT (the candidate's own first parent,
#      read from git; empty for a root commit)
#   42 OUTCOME=EXPIRED_HEAD_MOVED, CURRENT_HEAD
#   43 OUTCOME=TREE_MISMATCH, TREE_DIGEST
#   44 OUTCOME=PUSH_REJECTED         the destination refused the fast-forward
#   45 the fetched candidate is not CANDIDATE_SHA
#   46 OUTCOME=UNSUPPORTED_TREE_ENTRY (tree-digest/v1 has no gitlinks)
#   47 OUTCOME=BASELINE_MISMATCH     EXPECTED_HEAD is not an ancestor of the candidate
#   48 OUTCOME=UNRESOLVED_CONFLICT   a blob contains a git conflict-marker pair
#      (N>=7 '<' at the start of a line, and a later line of N '>'). Not a
#      semantic-conflict detector. Checked before any fast-forward, including
#      ALREADY_WRITTEN. A fetched commit has no unmerged index.
#   anything else: a git failure (retryable)
# src/lib/git-promotion.ts models this script step for step; the two are
# held together by test/fixtures/promotion-cases.json.
set -euo pipefail

# True (exit 0) when stdin contains a conflict-marker pair. A line of '='
# alone is not one. See src/lib/merge-artifacts.ts; the two must agree.
blob_has_conflict_markers() {
  # Associative, not indexed: a long run of '<' must not allocate a sparse array.
  local -A start=()
  local line ch i n rest width
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "${line:0:1}" in
      "<") ch="<" ;;
      ">") ch=">" ;;
      *) continue ;;
    esac
    n=${#line}
    i=0
    while [ "$i" -lt "$n" ] && [ "${line:i:1}" = "$ch" ]; do
      i=$((i + 1))
    done
    if [ "$i" -lt 7 ]; then
      continue
    fi
    if [ "$i" -lt "$n" ] && [ "${line:i:1}" != " " ]; then
      continue
    fi
    width=$i
    if [ "$ch" = "<" ]; then
      start[$width]=1
    elif [ -n "${start[$width]:-}" ]; then
      return 0
    fi
  done
  return 1
}

# Print one path per line for every blob with a conflict-marker pair.
# Reads NUL-terminated `git ls-tree -rz` records on stdin.
# The blob is written to a file before the scan. Piping it would let the
# scanner's early return deliver SIGPIPE to git cat-file (exit 141) and
# hide a marker hit behind a retryable git failure. A cat-file failure
# is not swallowed: set -e exits this pipeline, and the caller exits too.
unresolved_marker_paths() {
  local entry meta path rest type object scan
  while IFS= read -r -d '' entry; do
    [ -n "$entry" ] || continue
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    rest="${meta#* }"
    type="${rest%% *}"
    object="${rest##* }"
    [ "$type" = "blob" ] || continue
    git cat-file blob "$object" > "$WORK/blob"
    set +e
    blob_has_conflict_markers < "$WORK/blob"
    scan=$?
    set -e
    if [ "$scan" -eq 0 ]; then
      printf '%s\n' "$path"
    elif [ "$scan" -ne 1 ]; then
      return "$scan"
    fi
  done
}

WORK="${TMPDIR:-/tmp}/madgrix-${PERMIT_ID}"
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
set +e
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
DIGEST_STATUS=$?
set -e
if [ "$DIGEST_STATUS" -eq 46 ]; then
  printf 'OUTCOME=UNSUPPORTED_TREE_ENTRY\n'
  exit 46
fi
if [ "$DIGEST_STATUS" -ne 0 ]; then
  exit "$DIGEST_STATUS"
fi

# Before the digest comparison and before ALREADY_WRITTEN. A matching
# digest must not fast-forward a tree that still contains merge markers.
git ls-tree -rz --full-tree "$CANDIDATE_SHA" > "$WORK/lstree"
MARKER_PATHS="$(unresolved_marker_paths < "$WORK/lstree" | LC_ALL=C sort)" || exit $?
if [ -n "$MARKER_PATHS" ]; then
  joined="$(printf '%s\n' "$MARKER_PATHS" | paste -sd, -)"
  printf 'OUTCOME=UNRESOLVED_CONFLICT\nPATHS=%s\n' "$joined"
  exit 48
fi

if [ "$TREE_DIGEST" != "$WINNING_TREE_SHA256" ]; then
  printf 'OUTCOME=TREE_MISMATCH\nTREE_DIGEST=%s\n' "$TREE_DIGEST"
  exit 43
fi

# The candidate's own first parent, from git. It equals EXPECTED_HEAD only
# when the candidate is one commit above it.
PARENT="$(git rev-parse -q --verify "${CANDIDATE_SHA}^" || true)"

# Retry reconciliation: the reviewed candidate is already in the
# destination's history (our earlier push, possibly with commits on top
# since) and descends from the permit-bound head, so the write happened and
# only authority finalization remains. Requiring the second condition keeps
# a candidate that merely appears in the history from being reported as
# shipped on a base it does not descend from.
if git merge-base --is-ancestor "$CANDIDATE_SHA" "$CURRENT_HEAD" &&
  git merge-base --is-ancestor "$EXPECTED_HEAD" "$CANDIDATE_SHA"; then
  printf 'OUTCOME=ALREADY_WRITTEN\nPROMOTED_SHA=%s\nTREE_DIGEST=%s\nBASE=%s\nPARENT=%s\n' \
    "$CANDIDATE_SHA" "$TREE_DIGEST" "$EXPECTED_HEAD" "$PARENT"
  exit 0
fi

if [ "$CURRENT_HEAD" != "$EXPECTED_HEAD" ]; then
  printf 'OUTCOME=EXPIRED_HEAD_MOVED\nCURRENT_HEAD=%s\n' "$CURRENT_HEAD"
  exit 42
fi

# The reviewed commit itself must descend from the exact destination state
# bound into the permit; otherwise it has to be rebased (container/rebase.sh)
# into a new candidate and evaluated again.
if ! git merge-base --is-ancestor "$EXPECTED_HEAD" "$CANDIDATE_SHA"; then
  printf 'OUTCOME=BASELINE_MISMATCH\n'
  exit 47
fi

# Final compare-and-swap. A concurrent destination advance makes this
# non-fast-forward push fail; no stale reviewed state can ship.
if ! git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" push -q destination "$CANDIDATE_SHA:refs/heads/main"; then
  printf 'OUTCOME=PUSH_REJECTED\n'
  exit 44
fi

printf 'OUTCOME=PROMOTED\nPROMOTED_SHA=%s\nTREE_DIGEST=%s\nBASE=%s\nPARENT=%s\n' \
  "$CANDIDATE_SHA" "$TREE_DIGEST" "$EXPECTED_HEAD" "$PARENT"
