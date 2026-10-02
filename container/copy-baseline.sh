#!/usr/bin/env bash
set -euo pipefail

WORK="/tmp/madgrix-fork-${OP_ID}"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

git init -q
git remote add source "$SOURCE_REMOTE"
git remote add destination "$DESTINATION_REMOTE"

git -c "http.extraHeader=Authorization: Bearer $SOURCE_TOKEN" fetch -q --no-tags source "$SOURCE_COMMIT"
FETCHED="$(git rev-parse FETCH_HEAD)"
if [ "$FETCHED" != "$SOURCE_COMMIT" ]; then
  echo "source commit mismatch" >&2
  exit 45
fi

set +e
git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" fetch -q --no-tags destination main
DEST_FETCH=$?
set -e
if [ "$DEST_FETCH" -eq 0 ]; then
  CURRENT="$(git rev-parse FETCH_HEAD)"
  if [ "$CURRENT" = "$SOURCE_COMMIT" ]; then
    printf 'OUTCOME=ALREADY_IMPORTED\nHEAD=%s\n' "$CURRENT"
    exit 0
  fi
  printf 'OUTCOME=DESTINATION_NOT_EMPTY\nHEAD=%s\n' "$CURRENT"
  exit 42
fi

git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" push -q destination "$SOURCE_COMMIT:refs/heads/main"
printf 'OUTCOME=IMPORTED\nHEAD=%s\n' "$SOURCE_COMMIT"
