"""Exit 0 only when HEAD is the expected frozen baseline and the worktree is clean."""

import subprocess
import sys
from pathlib import Path


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=Path.cwd(),
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )


def main() -> int:
    if len(sys.argv) != 2:
        return 1
    expected = sys.argv[1]
    head = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain")
    if head.returncode != 0 or dirty.returncode != 0:
        return 1
    if head.stdout.strip() != expected or dirty.stdout.strip():
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
