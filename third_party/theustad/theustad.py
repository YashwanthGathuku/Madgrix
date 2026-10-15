#!/usr/bin/env python3
"""TheUstad 1.0 command-line orchestrator."""

import argparse
import json
import math
import os
import shlex
import sys
import tempfile
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, TextIO

from theustadlib import census, enrollment, hookadapter
from theustadlib.census import CENSUS_EVIDENCE, CENSUS_UNSUPERVISED
from theustadlib.chain import AuditChain
from theustadlib.chain import verify as verify_audit_chain
from theustadlib.claims import Claim, find_claims
from theustadlib.freezer import (
    DEFAULT_PATTERNS,
    Manifest,
    Tampering,
    check,
    freeze,
    restore,
)
from theustadlib.session import (
    DEFAULT_INITIAL_CMD,
    DEFAULT_RESUME_TEMPLATE,
    AgentSession,
    SessionResult,
)
from theustadlib.verifier import (
    VerificationResult,
    default_argv,
    parse_command as parse_verifier_command,
    run as run_verifier,
)


class Verdict(str, Enum):
    VERIFIED = "VERIFIED"
    FALSIFIED = "FALSIFIED"
    PASS_NO_CLAIM = "PASS_NO_CLAIM"
    INCOMPLETE = "INCOMPLETE"
    TAMPERED = "TAMPERED"
    AGENT_ERROR = "AGENT_ERROR"
    AGENT_TIMEOUT = "AGENT_TIMEOUT"


@dataclass(frozen=True)
class RoundResult:
    round_number: int
    verdict: Verdict
    agent: SessionResult
    claims: tuple[Claim, ...]
    verification: VerificationResult | None
    tampering: Tampering | None


@dataclass(frozen=True)
class TheUstadResult:
    verdict: Verdict
    exit_code: int
    rounds: tuple[RoundResult, ...]
    log_path: Path
    root: str


ClaimFinder = Callable[[str], list[Claim]]
VerifierRunner = Callable[[Sequence[str], Path, float], VerificationResult]
Output = Callable[[str], None]


def _console_output(line: str, *, stream: TextIO | None = None) -> None:
    target = sys.stdout if stream is None else stream
    encoding = getattr(target, "encoding", None) or "utf-8"
    safe_line = line.encode(encoding, errors="backslashreplace").decode(encoding)
    print(safe_line, file=target)


def verdict_for(claims: Sequence[Claim], verifier_exit_code: int) -> Verdict:
    """Apply the claim/verifier verdict matrix."""
    if claims:
        return Verdict.VERIFIED if verifier_exit_code == 0 else Verdict.FALSIFIED
    return (
        Verdict.PASS_NO_CLAIM
        if verifier_exit_code == 0
        else Verdict.INCOMPLETE
    )


def _tamper_data(stage: str, tampering: Tampering) -> dict[str, Any]:
    return {
        "stage": stage,
        "modified": tampering.modified,
        "deleted": tampering.deleted,
        "added": tampering.added,
    }


def _claim_data(message: str, claims: Sequence[Claim]) -> dict[str, Any]:
    return {
        "message": message,
        "matches": [
            {
                "sentence": claim.sentence,
                "phrases": list(claim.phrases),
            }
            for claim in claims
        ],
    }


def _tamper_resume_message(tampering: Tampering) -> str:
    return (
        "TheUstad detected protected-input tampering and restored the baseline. "
        "You must fix code rather than trusted tests. "
        f"Modified: {tampering.modified or ['none']}; "
        f"deleted: {tampering.deleted or ['none']}; "
        f"added: {tampering.added or ['none']}. "
        "Continue the task and report an explicit completion status."
    )


def _evidence_resume_message(
    verdict: Verdict, verification: VerificationResult
) -> str:
    evidence = "\n".join(verification.tail) or "Verifier produced no output."
    if verdict is Verdict.FALSIFIED:
        prefix = "TheUstad falsified the completion claim with the trusted verifier."
    else:
        prefix = "The trusted verifier still fails and the task is incomplete."
    return f"{prefix}\n\nVerifier evidence:\n{evidence}\n\nFix the code and report status."


STATUS_REQUEST = (
    "The trusted verifier passed, but your final message made no explicit "
    "completion claim. Reply once with an explicit completion status."
)

NO_PROTECTED_INPUTS = (
    "THEUSTAD_WARNING no protected inputs matched; TAMPERED can never be "
    "reported for this run. Point --protect/--protect-add at the real test "
    "and verifier-configuration paths before trusting the verdict."
)


class TheUstadRunner:
    """Execute TheUstad's ordered verification-and-retry loop."""

    def __init__(
        self,
        *,
        repo: str | os.PathLike[str],
        task: str,
        session: AgentSession,
        verifier_argv: Sequence[str],
        patterns: Iterable[str],
        state_dir: str | os.PathLike[str],
        log_dir: str | os.PathLike[str],
        max_retries: int,
        timeout: float,
        with_census: bool = True,
        verifier_runner: VerifierRunner = run_verifier,
        census_runner: VerifierRunner | None = None,
        claim_finder: ClaimFinder = find_claims,
        output: Output = _console_output,
    ):
        if max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        if timeout <= 0:
            raise ValueError("timeout must be positive")

        self.repo = Path(repo).resolve(strict=True)
        if not self.repo.is_dir():
            raise ValueError(f"repository is not a directory: {self.repo}")
        self.task = task
        self.session = session
        self.verifier_argv = tuple(verifier_argv)
        self.patterns = tuple(patterns)
        # Resolved here, not where they are used: the census report path is
        # handed to a verifier whose working directory is the repository, so
        # a relative --state-dir would have pytest write beside the code
        # while TheUstad reads beside the caller, and the census would stand
        # down over a report that was written all along.
        self.state_dir = Path(state_dir).resolve()
        self.log_dir = Path(log_dir).resolve()
        self.max_retries = max_retries
        self.timeout = timeout
        self.with_census = with_census
        self.verifier_runner = verifier_runner
        # The census probe is TheUstad's own measurement, never the acceptance
        # oracle, so it is kept off the verifier hook: "the verifier ran once,
        # and only when it should" stays a checkable property.
        self.census_runner = census_runner or run_verifier
        self.claim_finder = claim_finder
        self.output = output

    def _record_session(
        self,
        audit: AuditChain,
        round_number: int,
        result: SessionResult,
    ) -> None:
        audit.append(
            round_number=round_number,
            kind="session",
            data={
                "argv": list(result.argv),
                "thread_id": result.thread_id,
                "exit_code": result.exit_code,
                "timed_out": result.timed_out,
                "last_agent_message": result.last_agent_message,
                "non_json_tail": list(result.non_json_tail),
            },
        )
        for warning in result.warnings:
            audit.append(
                round_number=round_number,
                kind="warning",
                data={"message": warning},
            )

    def _restore_tampering(
        self,
        audit: AuditChain,
        manifest: Manifest,
        round_number: int,
        stage: str,
        tampering: Tampering,
    ) -> None:
        audit.append(
            round_number=round_number,
            kind="tamper",
            data=_tamper_data(stage, tampering),
        )
        restore(self.repo, manifest)

    def _record_verdict(
        self,
        audit: AuditChain,
        result: RoundResult,
    ) -> None:
        verification = result.verification
        audit.append(
            round_number=result.round_number,
            kind="verdict",
            data={
                "verdict": result.verdict.value,
                "claims": len(result.claims),
                "agent_exit_code": result.agent.exit_code,
                "verifier_exit_code": (
                    verification.exit_code if verification is not None else None
                ),
                "tampering": (
                    _tamper_data("detected", result.tampering)
                    if result.tampering is not None
                    else None
                ),
            },
        )
        self.output(f"ROUND {result.round_number} {result.verdict.value}")

    def run(self) -> TheUstadResult:
        manifest = freeze(self.repo, self.patterns, self.state_dir)
        audit = AuditChain(self.log_dir)
        self.output(f"PROTECTED {len(manifest.entries)} paths")
        if not manifest.entries:
            # An empty manifest silently voids the whole anti-tampering
            # guarantee, so it must never be indistinguishable from a real one.
            audit.append(
                round_number=0,
                kind="warning",
                data={"message": NO_PROTECTED_INPUTS, "patterns": list(self.patterns)},
            )
            self.output(NO_PROTECTED_INPUTS)

        baseline_census: dict[str, str] | None = None
        if self.with_census and not census.is_pytest_verifier(self.verifier_argv):
            # Hook mode says this at SessionStart and the README promises both
            # interfaces do. Standing down silently here was the same hole in
            # the other half of the product.
            self.output(CENSUS_UNSUPERVISED.format(detail="not supervising"))
        if self.with_census and census.is_pytest_verifier(self.verifier_argv):
            # Taken before the agent runs: a module-level skip planted later
            # removes tests from collection, so a late census is already shrunk.
            self.state_dir.mkdir(parents=True, exist_ok=True)
            probe_report = self.state_dir / "census-baseline.xml"
            census.clear_report(probe_report)
            probe = self.census_runner(
                census.probe_argv(self.verifier_argv, probe_report),
                self.repo,
                self.timeout,
            )
            collected = census.parse_report(probe_report)
            if collected and not census.required(collected):
                # Nothing in the baseline actually ran, so there is nothing to
                # supervise -- and saying so beats arming on an empty promise.
                collected = None
            # Not left behind: a round's report only has to look like this
            # one, and the verifier process can reach this directory.
            census.clear_report(probe_report)
            if collected:
                baseline_census = collected
                self.output(
                    f"CENSUS {len(census.required(collected))} acceptance tests"
                )
            else:
                # Either nothing was collected, or this verifier does not write
                # the report the census reads. Neither is the agent's doing, so
                # the census stands down instead of blocking every round -- but
                # standing down looks exactly like having nothing to report, so
                # it is said out loud rather than left to the audit chain.
                self.output(
                    CENSUS_UNSUPERVISED.format(detail="no usable baseline report")
                )

        rounds: list[RoundResult] = []
        resume_message: str | None = None
        status_resume_used = False

        for round_number in range(1, self.max_retries + 2):
            if resume_message is None:
                agent_result = self.session.start(self.task, on_line=self.output)
            else:
                audit.append(
                    round_number=round_number,
                    kind="resume",
                    data={"message": resume_message},
                )
                agent_result = self.session.resume(
                    resume_message,
                    on_line=self.output,
                )
                resume_message = None

            claims: tuple[Claim, ...] = ()
            verification: VerificationResult | None = None
            tampering: Tampering | None = None
            census_result: census.CensusResult | None = None

            tampering = check(self.repo, manifest)
            self._record_session(audit, round_number, agent_result)
            if tampering:
                self._restore_tampering(
                    audit,
                    manifest,
                    round_number,
                    "post_agent",
                    tampering,
                )
                verdict = Verdict.TAMPERED
            elif agent_result.timed_out:
                verdict = Verdict.AGENT_TIMEOUT
            elif agent_result.exit_code != 0:
                verdict = Verdict.AGENT_ERROR
            else:
                message = agent_result.last_agent_message or ""
                claims = tuple(self.claim_finder(message))
                audit.append(
                    round_number=round_number,
                    kind="claim",
                    data=_claim_data(message, claims),
                )

                tampering = check(self.repo, manifest)
                if tampering:
                    self._restore_tampering(
                        audit,
                        manifest,
                        round_number,
                        "pre_verifier",
                        tampering,
                    )
                    verdict = Verdict.TAMPERED
                else:
                    report_path = self.state_dir / f"census-{round_number}.xml"
                    census.clear_report(report_path)
                    verification = self.verifier_runner(
                        census.report_argv(self.verifier_argv, report_path)
                        if baseline_census is not None
                        else self.verifier_argv,
                        self.repo,
                        self.timeout,
                    )
                    if baseline_census is not None:
                        census_result = census.compare(
                            baseline_census,
                            census.parse_report(report_path),
                            verification.exit_code,
                        )
                    tampering = check(self.repo, manifest)
                    if tampering:
                        self._restore_tampering(
                            audit,
                            manifest,
                            round_number,
                            "post_verifier",
                            tampering,
                        )
                        verdict = Verdict.TAMPERED
                    else:
                        # A census failure means the exit code is not evidence,
                        # so it cannot carry the round to VERIFIED.
                        effective_exit = verification.exit_code or (
                            1 if census_result else 0
                        )
                        verdict = verdict_for(claims, effective_exit)
                        if census_result:
                            audit.append(
                                round_number=round_number,
                                kind="warning",
                                data={
                                    "message": census_result.detail,
                                    "reason": census_result.reason,
                                    "missing": list(census_result.missing),
                                },
                            )
                            self.output(
                                f"CENSUS {census_result.reason} "
                                f"{census_result.detail}"
                            )
                    if verification.warning:
                        audit.append(
                            round_number=round_number,
                            kind="warning",
                            data={"message": verification.warning},
                        )

            round_result = RoundResult(
                round_number=round_number,
                verdict=verdict,
                agent=agent_result,
                claims=claims,
                verification=verification,
                tampering=tampering if tampering else None,
            )
            rounds.append(round_result)
            self._record_verdict(audit, round_result)

            retries_remain = round_number <= self.max_retries
            if verdict is Verdict.VERIFIED:
                break
            if verdict in (Verdict.AGENT_ERROR, Verdict.AGENT_TIMEOUT):
                break
            if verdict is Verdict.PASS_NO_CLAIM:
                if status_resume_used or not retries_remain:
                    break
                status_resume_used = True
                resume_message = STATUS_REQUEST
                continue
            if not retries_remain:
                break
            if verdict is Verdict.TAMPERED:
                if round_result.tampering is None:
                    raise RuntimeError("TAMPERED verdict is missing file evidence")
                resume_message = _tamper_resume_message(round_result.tampering)
            elif verification is not None:
                resume_message = _evidence_resume_message(verdict, verification)
                # Same rule as hook mode: the census only explains a round the
                # verifier itself called a success.
                if census_result and verification.exit_code == 0:
                    resume_message = (
                        CENSUS_EVIDENCE.format(
                            reason=census_result.reason,
                            detail=census_result.detail,
                        )
                        + "\n\n"
                        + resume_message
                    )
            else:
                break

        final_verdict = rounds[-1].verdict
        exit_code = 0 if final_verdict is Verdict.VERIFIED else 1
        audit.append(
            round_number=rounds[-1].round_number,
            kind="final",
            data={"verdict": final_verdict.value, "exit_code": exit_code},
        )
        self.output(f"FINAL {final_verdict.value}")
        self.output(f"AUDIT_LOG {audit.path}")
        self.output(f"AUDIT_ROOT {audit.root}")
        self.output(
            "Anchor this SHA-256 root in a pushed Git commit and submission text."
        )
        return TheUstadResult(
            verdict=final_verdict,
            exit_code=exit_code,
            rounds=tuple(rounds),
            log_path=audit.path,
            root=audit.root,
        )


def _nonnegative(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be nonnegative")
    return parsed


def _positive(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _command_argv(command: str, label: str) -> list[str]:
    argv = shlex.split(command)
    if not argv:
        raise ValueError(f"{label} cannot be empty")
    if any(character in argument for argument in argv for character in "|&;<>"):
        raise ValueError(f"{label} cannot contain shell operators")
    return argv


TASK_FILE_SUFFIXES = frozenset({".md", ".markdown", ".rst", ".txt"})


def _looks_like_task_path(value: str) -> bool:
    """Report whether ``--task`` was meant as a file rather than inline text."""
    if value != value.strip() or len(value.split()) != 1:
        return False
    candidate = Path(value)
    if candidate.suffix.lower() in TASK_FILE_SUFFIXES:
        return True
    separators = {separator for separator in (os.sep, os.altsep) if separator}
    if not any(separator in value for separator in separators):
        return False
    # A separator alone is not enough: "refactor/rename" is an instruction,
    # not a path. Treat it as a path only when the directory it names exists.
    parent = candidate.parent
    return parent != Path(".") and parent.is_dir()


def _task_text(value: str | None) -> str:
    if value is None:
        return "Complete the repository task and report an explicit status."
    candidate = Path(value)
    if candidate.is_file():
        return candidate.read_text(encoding="utf-8")
    if _looks_like_task_path(value):
        # Silently prompting the agent with a mistyped path burns the whole
        # retry budget and records a meaningless audit chain.
        raise ValueError(f"task file not found: {candidate}")
    return value


def _flatten_patterns(groups: Sequence[Sequence[str]] | None) -> tuple[str, ...]:
    return tuple(item for group in (groups or ()) for item in group)


def _protected_patterns(
    overrides: Sequence[Sequence[str]] | None,
    additions: Sequence[Sequence[str]] | None,
) -> tuple[str, ...]:
    base = _flatten_patterns(overrides) if overrides else DEFAULT_PATTERNS
    return (*base, *_flatten_patterns(additions))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="theustad.py",
        description="Verify coding-agent completion claims with protected evidence.",
    )
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--task", help="task text or path to a task file")
    parser.add_argument("--cmd", help="custom initial agent command")
    parser.add_argument("--resume-cmd", help="custom resume command template")
    parser.add_argument("--verifier", help="custom verifier command without shell syntax")
    parser.add_argument(
        "--protect",
        action="append",
        nargs="+",
        metavar="PATTERN",
        help="protected path pattern; may be repeated",
    )
    parser.add_argument(
        "--protect-add",
        action="append",
        nargs="+",
        metavar="PATTERN",
        help="protected path pattern appended to the default or explicit set",
    )
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--max-retries", type=_nonnegative, default=3)
    parser.add_argument("--timeout", type=_positive, default=600.0)
    parser.add_argument("--log", type=Path, help="directory for timestamped audit logs")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument(
        "--no-census",
        action="store_true",
        help="skip the pytest test census (one extra verifier run at baseline)",
    )
    return parser


HOOK_COMMANDS = frozenset({"enroll", "status", "unenroll", "hook", "verify-chain"})


def build_hook_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="theustad.py",
        description="Manage fixed-policy automatic lifecycle hooks.",
    )
    commands = parser.add_subparsers(dest="hook_command", required=True)

    enroll_parser = commands.add_parser("enroll")
    enroll_parser.add_argument("--repo", required=True, type=Path)
    enroll_parser.add_argument(
        "--verifier", help="fixed verifier command; defaults to isolated pytest"
    )
    enroll_parser.add_argument(
        "--protect",
        action="append",
        nargs="+",
        metavar="PATTERN",
        help="replace the hook-mode protected patterns",
    )
    enroll_parser.add_argument(
        "--protect-add",
        action="append",
        nargs="+",
        metavar="PATTERN",
        help="append hook-mode protected patterns",
    )
    enroll_parser.add_argument("--timeout", type=_positive, default=300.0)
    enroll_parser.add_argument(
        "--hook-timeout",
        type=_positive,
        help=(
            "seconds emitted as the host hook timeout; defaults to the verifier "
            f"deadline plus {enrollment.MIN_HOOK_MARGIN:g}s"
        ),
    )
    enroll_parser.add_argument(
        "--calibrate",
        action="store_true",
        help="time the verifier first and refuse an unsafe hook timeout",
    )
    enroll_parser.add_argument(
        "--max-blocks", type=_positive_integer, default=5, metavar="N"
    )
    enroll_parser.add_argument("--require-claim", action="store_true")
    enroll_parser.add_argument(
        "--no-census",
        action="store_true",
        help="skip the pytest test census (one extra verifier run per session)",
    )

    status_parser = commands.add_parser("status")
    status_parser.add_argument("--repo", required=True, type=Path)

    unenroll_parser = commands.add_parser("unenroll")
    unenroll_parser.add_argument("--repo", required=True, type=Path)
    unenroll_parser.add_argument(
        "--yes", action="store_true", help="confirm removal of external policy"
    )

    hook_parser = commands.add_parser("hook", add_help=False)
    hook_parser.add_argument("hook_argv", nargs=argparse.REMAINDER)

    verify_parser = commands.add_parser("verify-chain")
    verify_parser.add_argument("--repo", required=True, type=Path)
    verify_parser.add_argument("--session-id")
    verify_parser.add_argument("--vendor", default="claude")
    return parser


def _hook_patterns(args: argparse.Namespace) -> tuple[str, ...]:
    base = (
        _flatten_patterns(args.protect)
        if args.protect
        else enrollment.HOOK_PATTERNS
    )
    return (*base, *_flatten_patterns(args.protect_add))


def _claude_hook_settings(hook_timeout: float) -> dict[str, Any]:
    python = str(Path(sys.executable).resolve(strict=True))
    cli = str(Path(__file__).resolve(strict=True))
    # An omitted timeout leaves the host's default in force, which may sit
    # below the verifier deadline; a cancelled hook renders no decision.
    timeout = int(math.ceil(hook_timeout))

    def entry(event: str) -> dict[str, Any]:
        return {
            "hooks": [
                {
                    "type": "command",
                    "command": shlex.join([python, cli, "hook", "claude", event]),
                    "timeout": timeout,
                }
            ]
        }

    return {"hooks": {"SessionStart": [entry("SessionStart")], "Stop": [entry("Stop")]}}


def _calibrate(
    repo: Path, verifier_argv: Sequence[str], timeout: float, runs: int = 3
) -> tuple[float, bool]:
    """Time the verifier under the deadline TheUstad will actually enforce.

    Measuring against the outer hook budget instead would accept a verifier
    that finishes inside the hook timeout but never inside its own deadline,
    so every real Stop would time out and the run could never verify.
    """
    durations: list[float] = []
    timed_out = False
    for attempt in range(1, runs + 1):
        started = time.monotonic()
        result = run_verifier(verifier_argv, repo, timeout)
        elapsed = time.monotonic() - started
        durations.append(elapsed)
        _console_output(
            f"CALIBRATE run {attempt}/{runs} {elapsed:.1f}s exit {result.exit_code}"
            + (" TIMEOUT" if result.timed_out else "")
        )
        if result.timed_out:
            # The outcome is already decided; further runs only burn deadlines.
            timed_out = True
            break
    # Nearest-rank p95; with three runs that is the slowest one, stated plainly.
    ordered = sorted(durations)
    index = min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1)
    return ordered[index], timed_out


def _enroll(args: argparse.Namespace) -> int:
    repo = args.repo.resolve(strict=True)
    verifier_argv = (
        parse_verifier_command(args.verifier, repo)
        if args.verifier
        else default_argv()
    )
    hook_timeout = args.hook_timeout
    if hook_timeout is None:
        hook_timeout = args.timeout + enrollment.MIN_HOOK_MARGIN

    if hook_timeout < args.timeout + enrollment.MIN_HOOK_MARGIN - 1e-6:
        # Pure arithmetic: fail before spending three verifier runs on it.
        raise ValueError(
            f"hook timeout {hook_timeout:g}s leaves less than "
            f"{enrollment.MIN_HOOK_MARGIN:g}s above the {args.timeout:g}s "
            "verifier deadline; the host would cancel the hook and render no "
            f"decision. Use --hook-timeout "
            f"{math.ceil(args.timeout + enrollment.MIN_HOOK_MARGIN)} "
            "or lower --timeout."
        )

    if args.calibrate:
        p95, timed_out = _calibrate(repo, verifier_argv, args.timeout)
        _console_output(f"CALIBRATE p95 {p95:.1f}s (slowest of 3 runs)")
        if timed_out or p95 >= args.timeout:
            raise ValueError(
                f"verifier p95 {p95:.1f}s does not fit the {args.timeout:g}s "
                "verifier deadline, so every Stop would time out and the run "
                f"could never verify. Rerun with --timeout {math.ceil(p95) + 1} "
                "or faster tests."
            )
        # The hook budget needs no separate check here: the static relation
        # above already guarantees hook_timeout >= timeout + margin, and p95
        # is now known to be under timeout.
        _console_output(
            f"CALIBRATE fits VERIFIER_DEADLINE {args.timeout:g}s and "
            f"HOOK_TIMEOUT {hook_timeout:g}s"
        )

    policy = enrollment.Policy(
        repo=str(repo),
        verifier_argv=tuple(verifier_argv),
        patterns=_hook_patterns(args),
        timeout=args.timeout,
        max_blocks=args.max_blocks,
        require_claim=args.require_claim,
        census=not args.no_census,
        hook_timeout=hook_timeout,
    )
    policy_path = enrollment.save_policy(policy)
    _console_output(f"ENROLLED {repo}")
    _console_output(f"POLICY {policy_path}")
    _console_output(f"STATE {enrollment.repository_state_dir(repo)}")
    _console_output(f"VERIFIER {shlex.join(policy.verifier_argv)}")
    _console_output(f"VERIFIER_DEADLINE {policy.timeout:g}s")
    _console_output(f"HOOK_TIMEOUT {policy.hook_timeout:g}s")
    _console_output(
        "Merge this block into ~/.claude/settings.json, then inspect it with /hooks:"
    )
    _console_output(json.dumps(_claude_hook_settings(policy.hook_timeout), indent=2))
    return 0


def _status(args: argparse.Namespace) -> int:
    repo = args.repo.resolve(strict=False)
    policy = enrollment.load_policy(repo)
    if policy is None:
        _console_output(f"NOT_ENROLLED {repo}")
        return 1
    audits = enrollment.audit_paths(repo)
    _console_output(f"ENROLLED {policy.repo}")
    _console_output(f"POLICY {enrollment.enrollment_path(repo)}")
    _console_output(f"STATE {enrollment.repository_state_dir(repo)}")
    _console_output(f"VERIFIER {shlex.join(policy.verifier_argv)}")
    _console_output(f"VERIFIER_DEADLINE {policy.timeout:g}s")
    _console_output(f"HOOK_TIMEOUT {policy.hook_timeout:g}s")
    _console_output(f"PROTECTED_PATTERNS {len(policy.patterns)}")
    _console_output(f"MAX_BLOCKS {policy.max_blocks}")
    _console_output(f"REQUIRE_CLAIM {str(policy.require_claim).lower()}")
    _console_output(f"CENSUS {str(policy.census).lower()}")
    _console_output(f"AUDIT_CHAINS {len(audits)}")
    return 0


def _unenroll(args: argparse.Namespace) -> int:
    repo = args.repo.resolve(strict=False)
    if not args.yes:
        _console_output(
            f"REFUSED confirmation required; rerun with: "
            f"{shlex.join([sys.executable, str(Path(__file__).resolve()), 'unenroll', '--repo', str(repo), '--yes'])}",
            stream=sys.stderr,
        )
        return 2
    removed = enrollment.delete_policy(repo)
    _console_output(f"UNENROLLED {repo}" if removed else f"NOT_ENROLLED {repo}")
    return 0 if removed else 1


def _verify_hook_chains(args: argparse.Namespace) -> int:
    repo = args.repo.resolve(strict=False)
    if args.session_id:
        binding = enrollment.load_binding(args.vendor, args.session_id)
        if binding is None or Path(binding.repo) != repo:
            _console_output("THEUSTAD_ERROR matching hook session not found", stream=sys.stderr)
            return 2
        paths = [Path(binding.audit_path)]
    else:
        paths = enrollment.audit_paths(repo)
    if not paths:
        _console_output(f"THEUSTAD_ERROR no hook audit chains for {repo}", stream=sys.stderr)
        return 2
    failures = 0
    for path in paths:
        try:
            count, root = verify_audit_chain(path)
        except (OSError, ValueError) as error:
            # One unreadable chain must not hide the verdict on every other.
            failures += 1
            _console_output(f"BROKEN {path}: {error}", stream=sys.stderr)
            continue
        _console_output(f"VALID {path}: {count} records, root {root}")
    return 2 if failures else 0


def _hook_command(argv: Sequence[str]) -> int:
    parser = build_hook_parser()
    args = parser.parse_args(argv)
    try:
        if args.hook_command == "enroll":
            return _enroll(args)
        if args.hook_command == "status":
            return _status(args)
        if args.hook_command == "unenroll":
            return _unenroll(args)
        if args.hook_command == "hook":
            return hookadapter.main(args.hook_argv)
        if args.hook_command == "verify-chain":
            return _verify_hook_chains(args)
        raise ValueError(f"unsupported hook command: {args.hook_command}")
    except Exception as error:
        # Never let an unexpected exception pick the exit code for us.
        _console_output(
            f"THEUSTAD_ERROR {type(error).__name__}: {error}", stream=sys.stderr
        )
        return 2


def main(argv: Sequence[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    if values and values[0] in HOOK_COMMANDS:
        return _hook_command(values)
    parser = build_parser()
    args = parser.parse_args(values)

    try:
        repo = args.repo.resolve(strict=True)
        task = _task_text(args.task)
        initial_cmd = (
            _command_argv(args.cmd, "agent command")
            if args.cmd
            else list(DEFAULT_INITIAL_CMD)
        )
        resume_template = (
            _command_argv(args.resume_cmd, "resume command")
            if args.resume_cmd
            else list(DEFAULT_RESUME_TEMPLATE)
        )
        verifier_argv = (
            parse_verifier_command(args.verifier, repo)
            if args.verifier
            else default_argv()
        )
        patterns = _protected_patterns(args.protect, args.protect_add)
        state_dir = args.state_dir or Path(
            tempfile.mkdtemp(prefix="theustad-state-")
        )
        log_dir = args.log or state_dir / "logs"
        session = AgentSession(
            initial_cmd,
            resume_template,
            repo,
            args.timeout,
        )
        runner = TheUstadRunner(
            repo=repo,
            task=task,
            session=session,
            verifier_argv=verifier_argv,
            patterns=patterns,
            state_dir=state_dir,
            log_dir=log_dir,
            max_retries=args.max_retries,
            timeout=args.timeout,
            with_census=not args.no_census,
        )
        return runner.run().exit_code
    except Exception as error:
        _console_output(
            f"THEUSTAD_ERROR {type(error).__name__}: {error}", stream=sys.stderr
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
