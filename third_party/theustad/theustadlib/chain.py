"""Append-only SHA-256 audit chains."""

import hashlib
import json
import os
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ZERO_ROOT = "0" * 64
RECORD_KINDS = frozenset(
    {"session", "claim", "verdict", "tamper", "resume", "warning", "final"}
)

Clock = Callable[[], datetime]


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def verify(path: str | os.PathLike[str]) -> tuple[int, str]:
    """Validate an existing audit chain and return ``(count, root)``.

    Hook mode spans multiple processes, so it must reopen one chain without
    trusting the last line.  Recomputing every record here keeps the append
    path byte-compatible with the independent ``verify_chain.py`` oracle.
    """
    audit_path = Path(path)
    if audit_path.is_symlink() or not audit_path.is_file():
        raise ValueError(f"audit path is not a regular file: {audit_path}")

    previous = ZERO_ROOT
    count = 0
    with audit_path.open("rb") as audit:
        for line_number, raw_line in enumerate(audit):
            try:
                line = raw_line.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(
                    f"broken audit chain at seq {line_number}: invalid UTF-8"
                ) from error
            try:
                stored = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"broken audit chain at seq {line_number}: invalid JSON"
                ) from error
            if not isinstance(stored, dict):
                raise ValueError(
                    f"broken audit chain at seq {line_number}: record is not an object"
                )
            claimed = stored.pop("hash", None)
            if stored.get("seq") != line_number:
                raise ValueError(
                    f"broken audit chain at seq {line_number}: sequence mismatch"
                )
            if stored.get("prev") != previous:
                raise ValueError(
                    f"broken audit chain at seq {line_number}: prev-link mismatch"
                )
            actual = hashlib.sha256(
                (previous + _canonical_json(stored)).encode("utf-8")
            ).hexdigest()
            if claimed != actual:
                raise ValueError(
                    f"broken audit chain at seq {line_number}: hash mismatch"
                )
            previous = actual
            count += 1
    if count == 0:
        # An emptied or truncated log attests nothing; both oracles refuse it.
        raise ValueError("broken audit chain at seq 0: audit chain is empty")
    return count, previous


class AuditChain:
    """Write one fresh, oracle-compatible audit log."""

    def __init__(self, directory: str | os.PathLike[str], *, clock: Clock | None = None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.path = self._create_log(_utc(self._clock()))
        self.root = ZERO_ROOT
        self.count = 0

    @classmethod
    def resume(
        cls,
        path: str | os.PathLike[str],
        *,
        clock: Clock | None = None,
    ) -> "AuditChain":
        """Reopen one validated chain for append-only hook invocations."""
        audit_path = Path(path).resolve(strict=True)
        count, root = verify(audit_path)
        chain = cls.__new__(cls)
        chain.directory = audit_path.parent
        chain._clock = clock or (lambda: datetime.now(timezone.utc))
        chain.path = audit_path
        chain.root = root
        chain.count = count
        return chain

    def _create_log(self, started_at: datetime) -> Path:
        candidate_time = started_at
        while True:
            name = candidate_time.strftime("audit_%Y%m%d_%H%M%S.jsonl")
            candidate = self.directory / name
            try:
                with candidate.open("x", encoding="utf-8", newline="\n"):
                    pass
            except FileExistsError:
                candidate_time += timedelta(seconds=1)
                continue
            return candidate

    def append(self, *, round_number: int, kind: str, data: Any) -> str:
        """Append one record and return its hash, which becomes the chain root."""
        if kind not in RECORD_KINDS:
            raise ValueError(f"unsupported audit record kind: {kind}")

        record = {
            "seq": self.count,
            "ts": _utc(self._clock()).isoformat(),
            "round": round_number,
            "kind": kind,
            "data": data,
            "prev": self.root,
        }
        digest = hashlib.sha256(
            (self.root + _canonical_json(record)).encode("utf-8")
        ).hexdigest()
        line = _canonical_json({**record, "hash": digest}) + "\n"

        with self.path.open("a", encoding="utf-8", newline="\n") as log:
            log.write(line)
            log.flush()
            os.fsync(log.fileno())

        self.root = digest
        self.count += 1
        return digest
