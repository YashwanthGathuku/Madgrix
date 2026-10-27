"""External policy and per-session state for automatic hook mode.

Hook commands intentionally accept no verifier or protection arguments.  The
user enrolls a repository once, and lifecycle hooks load that fixed policy
from ``THEUSTAD_HOME`` (``~/.theustad`` by default), outside the target repo.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import stat
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .freezer import DEFAULT_PATTERNS, Manifest, ManifestEntry


DEFAULT_HOME = "~/.theustad"
POLICY_VERSION = 1
MAX_CLAUDE_BLOCKS = 7
# A host that cancels a hook at its timeout discards the hook's output and
# renders no decision, so a verifier allowed to outlive the hook turns a
# blocking result into a silent pass.  The verifier deadline must therefore
# sit strictly below the hook timeout, with room for TheUstad's own work.
MIN_HOOK_MARGIN = 15.0
_MARGIN_TOLERANCE = 1e-6
HOOK_PATTERNS = (
    *DEFAULT_PATTERNS,
    ".claude/settings.json",
    ".claude/settings.local.json",
)


def home() -> Path:
    """Return the external TheUstad state root."""
    configured = os.environ.get("THEUSTAD_HOME", DEFAULT_HOME)
    return Path(configured).expanduser().resolve(strict=False)


def _canonical_repo(repo: str | os.PathLike[str], *, strict: bool) -> Path:
    path = Path(repo).expanduser().resolve(strict=strict)
    if strict and not path.is_dir():
        raise ValueError(f"repository is not a directory: {path}")
    return path


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def validate_external_home(repo: str | os.PathLike[str]) -> Path:
    repository = _canonical_repo(repo, strict=True)
    state_home = home()
    if _is_within(state_home, repository):
        raise ValueError("THEUSTAD_HOME must be outside the enrolled repository")
    return state_home


def enrollment_key(repo: str | os.PathLike[str]) -> str:
    canonical = str(_canonical_repo(repo, strict=False))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def session_key(vendor: str, session_id: str) -> str:
    if not vendor or not session_id:
        raise ValueError("vendor and session_id are required")
    material = f"{vendor}\0{session_id}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def enrollment_path(repo: str | os.PathLike[str]) -> Path:
    return home() / "enrollments" / f"{enrollment_key(repo)}.json"


def repository_state_dir(repo: str | os.PathLike[str]) -> Path:
    return home() / "state" / enrollment_key(repo)


def session_state_dir(
    repo: str | os.PathLike[str], vendor: str, session_id: str
) -> Path:
    return repository_state_dir(repo) / session_key(vendor, session_id)


def binding_path(vendor: str, session_id: str) -> Path:
    return home() / "sessions" / vendor / f"{session_key(vendor, session_id)}.json"


def _secure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def _atomic_json(path: Path, data: dict[str, Any]) -> Path:
    _secure_directory(path.parent)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            json.dump(data, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return path


def _read_json(path: Path) -> dict[str, Any] | None:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ValueError(f"cannot safely open JSON state: {path}") from error
    with os.fdopen(descriptor, "r", encoding="utf-8") as source:
        file_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(file_stat.st_mode):
            raise ValueError(f"state path is not a regular file: {path}")
        if file_stat.st_size > 10 * 1024 * 1024:
            raise ValueError(f"JSON state is unexpectedly large: {path}")
        try:
            value = json.load(source)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSON state: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"JSON state is not an object: {path}")
    return value


@dataclass(frozen=True)
class Policy:
    repo: str
    verifier_argv: tuple[str, ...]
    patterns: tuple[str, ...] = HOOK_PATTERNS
    timeout: float = 300.0
    max_blocks: int = 5
    require_claim: bool = False
    hook_timeout: float | None = None
    census: bool = True
    version: int = POLICY_VERSION

    def __post_init__(self) -> None:
        canonical = str(_canonical_repo(self.repo, strict=False))
        object.__setattr__(self, "repo", canonical)
        object.__setattr__(self, "verifier_argv", tuple(self.verifier_argv))
        object.__setattr__(self, "patterns", tuple(self.patterns))
        if not self.verifier_argv or not all(
            isinstance(item, str) and item for item in self.verifier_argv
        ):
            raise ValueError("verifier argv cannot be empty")
        if not self.patterns or not all(
            isinstance(item, str) and item for item in self.patterns
        ):
            raise ValueError("protected patterns cannot be empty")
        if isinstance(self.timeout, bool) or not isinstance(self.timeout, (int, float)):
            raise ValueError("verifier timeout must be numeric")
        if not math.isfinite(self.timeout) or self.timeout <= 0:
            raise ValueError("verifier timeout must be positive")
        if isinstance(self.max_blocks, bool) or not isinstance(self.max_blocks, int):
            raise ValueError("max_blocks must be an integer")
        if not 1 <= self.max_blocks <= MAX_CLAUDE_BLOCKS:
            raise ValueError(
                f"max_blocks must be between 1 and {MAX_CLAUDE_BLOCKS}"
            )
        if not isinstance(self.require_claim, bool):
            raise ValueError("require_claim must be boolean")
        hook_timeout = self.hook_timeout
        if hook_timeout is None:
            hook_timeout = self.timeout + MIN_HOOK_MARGIN
        if isinstance(hook_timeout, bool) or not isinstance(
            hook_timeout, (int, float)
        ):
            raise ValueError("hook timeout must be numeric")
        hook_timeout = float(hook_timeout)
        if not math.isfinite(hook_timeout) or hook_timeout <= 0:
            raise ValueError("hook timeout must be positive")
        # Binary floating point makes (t + 15.0) - t land just under 15.0 for
        # many values, so an exact comparison would reject the margin this
        # class itself derives.  Compare against the sum with a tolerance.
        required = self.timeout + MIN_HOOK_MARGIN
        if hook_timeout < required - _MARGIN_TOLERANCE:
            raise ValueError(
                f"hook timeout {hook_timeout:g}s leaves less than "
                f"{MIN_HOOK_MARGIN:g}s above the {self.timeout:g}s verifier "
                "deadline; the host would cancel the hook and render no "
                f"decision. Use --hook-timeout {math.ceil(required)} "
                "or lower --timeout."
            )
        object.__setattr__(self, "hook_timeout", hook_timeout)
        if isinstance(self.version, bool) or not isinstance(self.version, int):
            raise ValueError("policy version must be an integer")
        if self.version != POLICY_VERSION:
            raise ValueError(f"unsupported enrollment policy version: {self.version}")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["verifier_argv"] = list(self.verifier_argv)
        value["patterns"] = list(self.patterns)
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Policy":
        try:
            verifier_argv = value["verifier_argv"]
            patterns = value.get("patterns", list(HOOK_PATTERNS))
            require_claim = value.get("require_claim", False)
            supervise = value.get("census", True)
            if not isinstance(verifier_argv, list) or not all(
                isinstance(item, str) for item in verifier_argv
            ):
                raise ValueError("verifier_argv must be a string array")
            if not isinstance(patterns, list) or not all(
                isinstance(item, str) for item in patterns
            ):
                raise ValueError("patterns must be a string array")
            if not isinstance(require_claim, bool):
                raise ValueError("require_claim must be boolean")
            if not isinstance(supervise, bool):
                raise ValueError("census must be boolean")
            return cls(
                repo=str(value["repo"]),
                verifier_argv=tuple(verifier_argv),
                patterns=tuple(patterns),
                timeout=float(value.get("timeout", 300.0)),
                max_blocks=int(value.get("max_blocks", 5)),
                require_claim=require_claim,
                census=supervise,
                hook_timeout=(
                    float(value["hook_timeout"])
                    if value.get("hook_timeout") is not None
                    else None
                ),
                version=int(value.get("version", POLICY_VERSION)),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("invalid enrollment policy") from error


def save_policy(policy: Policy) -> Path:
    validate_external_home(policy.repo)
    return _atomic_json(enrollment_path(policy.repo), policy.to_dict())


def load_policy(repo: str | os.PathLike[str]) -> Policy | None:
    repository = _canonical_repo(repo, strict=False)
    value = _read_json(enrollment_path(repository))
    if value is None:
        return None
    policy = Policy.from_dict(value)
    if Path(policy.repo) != repository:
        raise ValueError("enrollment policy repository mismatch")
    return policy


def find_policy(cwd: str | os.PathLike[str]) -> Policy | None:
    """Find an enrollment for ``cwd`` or one of its parents."""
    current = _canonical_repo(cwd, strict=True)
    for candidate in (current, *current.parents):
        policy = load_policy(candidate)
        if policy is not None:
            return policy
    return None


def delete_policy(repo: str | os.PathLike[str]) -> bool:
    path = enrollment_path(repo)
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def manifest_to_dict(manifest: Manifest) -> dict[str, Any]:
    return {
        "repo": str(manifest.repo),
        "state_dir": str(manifest.state_dir),
        "snapshot_dir": str(manifest.snapshot_dir),
        "patterns": list(manifest.patterns),
        "entries": {
            relative: {
                "path": entry.path,
                "file_type": entry.file_type,
                "sha256": entry.sha256,
                "mode": entry.mode,
                "snapshot_path": (
                    str(entry.snapshot_path) if entry.snapshot_path else None
                ),
            }
            for relative, entry in manifest.entries.items()
        },
    }


def _safe_relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or value in ("", "."):
        raise ValueError(f"unsafe manifest path: {value}")
    return path


def manifest_from_dict(
    value: dict[str, Any],
    *,
    expected_state_dir: Path | None = None,
    expected_repo: Path | None = None,
) -> Manifest:
    try:
        repo = Path(str(value["repo"])).resolve(strict=True)
        state_dir = Path(str(value["state_dir"])).resolve(strict=True)
        snapshot_dir = Path(str(value["snapshot_dir"])).resolve(strict=True)
        raw_entries = value["entries"]
        patterns = tuple(str(item) for item in value["patterns"])
    except (KeyError, TypeError, OSError) as error:
        raise ValueError("invalid manifest metadata") from error
    if expected_repo is not None and repo != expected_repo.resolve(strict=True):
        raise ValueError("manifest repository mismatch")
    if expected_state_dir is not None and state_dir != expected_state_dir.resolve(
        strict=True
    ):
        raise ValueError("manifest state directory mismatch")
    if not _is_within(snapshot_dir, state_dir):
        raise ValueError("manifest snapshot is outside session state")
    if not isinstance(raw_entries, dict):
        raise ValueError("invalid manifest entries")

    entries: dict[str, ManifestEntry] = {}
    for relative, raw_entry in raw_entries.items():
        if not isinstance(relative, str) or not isinstance(raw_entry, dict):
            raise ValueError("invalid manifest entry")
        relative_path = _safe_relative(relative)
        if raw_entry.get("path") != relative:
            raise ValueError("manifest entry path mismatch")
        file_type = str(raw_entry.get("file_type"))
        if file_type not in {"file", "directory"}:
            raise ValueError(f"unsupported manifest file type: {file_type}")
        snapshot_value = raw_entry.get("snapshot_path")
        snapshot_path = Path(snapshot_value).resolve(strict=True) if snapshot_value else None
        if file_type == "file":
            expected_snapshot = (snapshot_dir / "files" / relative_path).resolve(
                strict=True
            )
            if snapshot_path != expected_snapshot:
                raise ValueError("manifest snapshot path mismatch")
        elif snapshot_path is not None:
            raise ValueError("directory manifest entry has a snapshot")
        entries[relative] = ManifestEntry(
            path=relative,
            file_type=file_type,
            sha256=raw_entry.get("sha256"),
            mode=int(raw_entry.get("mode")),
            snapshot_path=snapshot_path,
        )
    return Manifest(
        repo=repo,
        state_dir=state_dir,
        snapshot_dir=snapshot_dir,
        patterns=patterns,
        entries=entries,
    )


def save_manifest(state_dir: Path, manifest: Manifest) -> Path:
    return _atomic_json(state_dir / "manifest.json", manifest_to_dict(manifest))


def load_manifest(state_dir: Path, repo: Path) -> Manifest | None:
    value = _read_json(state_dir / "manifest.json")
    if value is None:
        return None
    return manifest_from_dict(
        value,
        expected_state_dir=state_dir,
        expected_repo=repo,
    )


def save_session_policy(state_dir: Path, policy: Policy) -> Path:
    return _atomic_json(state_dir / "policy.json", policy.to_dict())


def load_session_policy(state_dir: Path, repo: Path) -> Policy:
    value = _read_json(state_dir / "policy.json")
    if value is None:
        raise ValueError("session policy is missing")
    policy = Policy.from_dict(value)
    if Path(policy.repo) != repo.resolve(strict=True):
        raise ValueError("session policy repository mismatch")
    return policy


@dataclass(frozen=True)
class SessionBinding:
    vendor: str
    session_id: str
    repo: str
    state_dir: str
    audit_path: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SessionBinding":
        try:
            fields = {
                name: value[name]
                for name in ("vendor", "session_id", "repo", "state_dir", "audit_path")
            }
            if not all(isinstance(item, str) and item for item in fields.values()):
                raise ValueError("session binding fields must be non-empty strings")
            return cls(
                vendor=fields["vendor"],
                session_id=fields["session_id"],
                repo=fields["repo"],
                state_dir=fields["state_dir"],
                audit_path=fields["audit_path"],
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("invalid session binding") from error


def save_binding(binding: SessionBinding) -> Path:
    expected = binding_path(binding.vendor, binding.session_id)
    return _atomic_json(expected, binding.to_dict())


# A SessionStart that continues something rather than beginning it.  The
# specification is explicit that these must never re-freeze a changed
# protected tree or reset the retry counter (SPEC 4.8a).
CONTINUATION_SOURCES = frozenset({"resume", "clear", "compact", "fork"})


def adoptable_state(repo: str | os.PathLike[str]) -> Path | None:
    """The most recent unfinished session state for this repository.

    A continuation whose session id TheUstad has not bound would otherwise
    start a fresh baseline from a tree the agent has already been editing.
    Taking over the existing state keeps the manifest, the block count, the
    census baseline and the audit chain that session was working under.

    A session that reached a terminal verdict is not adopted: it is finished,
    and a genuinely new session should baseline for itself.
    """
    root = repository_state_dir(repo)
    if not root.is_dir():
        return None
    candidates = [
        directory
        for directory in root.iterdir()
        if directory.is_dir()
        and (directory / "manifest.json").is_file()
        and terminal_verdict(directory) is None
    ]
    if not candidates:
        return None
    # Most recently touched: the continuation came from the session that was
    # running, and an older baseline would hold the agent to a tree that has
    # legitimately moved on.
    return max(candidates, key=lambda directory: directory.stat().st_mtime)


def load_binding(vendor: str, session_id: str) -> SessionBinding | None:
    value = _read_json(binding_path(vendor, session_id))
    if value is None:
        return None
    binding = SessionBinding.from_dict(value)
    if binding.vendor != vendor or binding.session_id != session_id:
        raise ValueError("session binding identity mismatch")
    expected_state = session_state_dir(binding.repo, vendor, session_id).resolve(
        strict=True
    )
    if Path(binding.state_dir).resolve(strict=True) != expected_state:
        raise ValueError("session binding state directory mismatch")
    audit_path = Path(binding.audit_path).resolve(strict=True)
    if not _is_within(audit_path, expected_state):
        raise ValueError("session audit path is outside session state")
    return binding


def block_count(state_dir: Path) -> int:
    value = _read_json(state_dir / "blocks.json")
    if value is None:
        return 0
    try:
        count = int(value["blocks"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid hook block counter") from error
    if count < 0:
        raise ValueError("invalid hook block counter")
    return count


def bump_blocks(state_dir: Path) -> int:
    count = block_count(state_dir) + 1
    _atomic_json(state_dir / "blocks.json", {"blocks": count})
    return count


def reset_blocks(state_dir: Path) -> None:
    _atomic_json(state_dir / "blocks.json", {"blocks": 0})


def mark_terminal(state_dir: Path, verdict: str) -> None:
    _atomic_json(state_dir / "terminal.json", {"verdict": verdict})


def terminal_verdict(state_dir: Path) -> str | None:
    value = _read_json(state_dir / "terminal.json")
    if value is None:
        return None
    try:
        return str(value["verdict"])
    except KeyError as error:
        raise ValueError("invalid terminal verdict record") from error


def audit_paths(repo: str | os.PathLike[str]) -> list[Path]:
    root = repository_state_dir(repo)
    if not root.exists():
        return []
    return sorted(root.glob("*/logs/audit_*.jsonl"))
