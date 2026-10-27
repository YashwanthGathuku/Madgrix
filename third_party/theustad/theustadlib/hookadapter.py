"""Automatic lifecycle-hook adapter for TheUstad.

Wrapper mode remains the highest-assurance interface because TheUstad owns the
agent process.  Hook mode is a lower-friction guardrail: the host invokes this
module, while verifier policy and snapshots remain outside the target repo.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Sequence

from . import census, enrollment
from .census import CENSUS_EVIDENCE, CENSUS_UNSUPERVISED
from .chain import AuditChain
from .claims import Claim, find_claims
from .freezer import Tampering, check, freeze, restore
from .verifier import VerificationResult, run as run_verifier


ALLOW = 0
BLOCK = 2
INTERNAL_ERROR = "INTERNAL_ERROR"
FORBIDDEN_POLICY_OPTIONS = frozenset(
    {
        "--verifier",
        "--repo",
        "--protect",
        "--protect-add",
        "--protected",
        "--patterns",
        "--timeout",
        "--policy",
        "--state-dir",
    }
)


class HookVerdict(str, Enum):
    VERIFIED = "VERIFIED"
    FALSIFIED = "FALSIFIED"
    PASS_NO_CLAIM = "PASS_NO_CLAIM"
    INCOMPLETE = "INCOMPLETE"
    TAMPERED = "TAMPERED"
    VERIFIER_TIMEOUT = "VERIFIER_TIMEOUT"
    VERIFIER_ERROR = "VERIFIER_ERROR"
    BACKGROUND_ACTIVE = "BACKGROUND_ACTIVE"
    RETRY_EXHAUSTED = "RETRY_EXHAUSTED"


@dataclass(frozen=True)
class HookEvent:
    session_id: str
    cwd: Path
    event: str
    source: str | None = None
    stop_active: bool = False
    last_assistant_message: str = ""
    background_tasks: tuple[dict[str, Any], ...] = ()
    session_crons: tuple[dict[str, Any], ...] = ()
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class HookResponse:
    exit_code: int
    stderr: str = ""
    stdout: dict[str, Any] | None = None


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"hook payload requires non-empty {key}")
    return value


def parse_claude(payload: dict[str, Any]) -> HookEvent:
    """Parse the documented Claude Code SessionStart or Stop schema."""
    if not isinstance(payload, dict):
        raise ValueError("hook payload must be a JSON object")
    hook_name = _required_text(payload, "hook_event_name")
    event_names = {"SessionStart": "session_start", "Stop": "stop"}
    try:
        event = event_names[hook_name]
    except KeyError as error:
        raise ValueError(f"unsupported Claude hook event: {hook_name}") from error

    session_id = _required_text(payload, "session_id")
    cwd = Path(_required_text(payload, "cwd")).expanduser().resolve(strict=True)
    if not cwd.is_dir():
        raise ValueError(f"hook cwd is not a directory: {cwd}")

    if event == "session_start":
        source = _required_text(payload, "source")
        stop_active = False
        message = ""
        background_tasks: tuple[dict[str, Any], ...] = ()
        session_crons: tuple[dict[str, Any], ...] = ()
    else:
        source = None
        stop_value = payload.get("stop_hook_active")
        if not isinstance(stop_value, bool):
            raise ValueError("Stop payload requires boolean stop_hook_active")
        stop_active = stop_value
        if "last_assistant_message" not in payload:
            raise ValueError("Stop payload requires last_assistant_message")
        message_value = payload["last_assistant_message"]
        if not isinstance(message_value, str):
            raise ValueError("Stop payload last_assistant_message must be a string")
        message = message_value
        background_value = payload.get("background_tasks", [])
        if not isinstance(background_value, list) or not all(
            isinstance(item, dict) for item in background_value
        ):
            raise ValueError("Stop payload background_tasks must be an array")
        background_tasks = tuple(background_value)
        cron_value = payload.get("session_crons", [])
        if not isinstance(cron_value, list) or not all(
            isinstance(item, dict) for item in cron_value
        ):
            raise ValueError("Stop payload session_crons must be an array")
        session_crons = tuple(cron_value)

    return HookEvent(
        session_id=session_id,
        cwd=cwd,
        event=event,
        source=source,
        stop_active=stop_active,
        last_assistant_message=message,
        background_tasks=background_tasks,
        session_crons=session_crons,
        raw=payload,
    )


ADAPTERS = {"claude": parse_claude}


def _claim_data(message: str, claims: Sequence[Claim]) -> dict[str, Any]:
    return {
        "message": message,
        "matches": [
            {"sentence": claim.sentence, "phrases": list(claim.phrases)}
            for claim in claims
        ],
    }


def _tamper_data(stage: str, tampering: Tampering) -> dict[str, Any]:
    return {
        "stage": stage,
        "modified": tampering.modified,
        "deleted": tampering.deleted,
        "added": tampering.added,
    }


NO_PROTECTED_INPUTS = (
    "TheUstad WARNING: the enrolled protected patterns matched nothing in "
    "this repository, so TAMPERED can never be reported for this session. "
    "Re-run `theustad.py enroll --protect-add ...` against the real test and "
    "verifier-configuration paths."
)


def _system_message(message: str) -> HookResponse:
    return HookResponse(ALLOW, stdout={"systemMessage": message})


def _tamper_response(tampering: Tampering, stage: str) -> HookResponse:
    label = "during verification" if stage == "post_verifier" else "before verification"
    return HookResponse(
        BLOCK,
        stderr=(
            f"TheUstad verdict: TAMPERED ({label})\n"
            f"modified: {tampering.modified or ['none']}\n"
            f"deleted: {tampering.deleted or ['none']}\n"
            f"added: {tampering.added or ['none']}\n"
            "Protected inputs were restored. Fix application code, not the "
            "trusted tests or verifier configuration."
        ),
    )


def _record_tampering(
    audit: AuditChain,
    repo: Path,
    manifest,
    round_number: int,
    stage: str,
    tampering: Tampering,
) -> HookResponse:
    audit.append(
        round_number=round_number,
        kind="tamper",
        data=_tamper_data(stage, tampering),
    )
    restore(repo, manifest)
    audit.append(
        round_number=round_number,
        kind="verdict",
        data={"verdict": HookVerdict.TAMPERED.value, "stage": stage},
    )
    return _tamper_response(tampering, stage)


def _load_session(event: HookEvent, vendor: str):
    binding = enrollment.load_binding(vendor, event.session_id)
    if binding is None:
        return None
    repo = Path(binding.repo).resolve(strict=True)
    if not repo.is_dir():
        raise ValueError(f"bound repository is not a directory: {repo}")
    state_dir = Path(binding.state_dir).resolve(strict=True)
    policy = enrollment.load_session_policy(state_dir, repo)
    manifest = enrollment.load_manifest(state_dir, repo)
    if manifest is None:
        raise ValueError("protected-input baseline is missing")
    audit = AuditChain.resume(binding.audit_path)
    return binding, repo, state_dir, policy, manifest, audit


def handle_session_start(event: HookEvent, vendor: str) -> HookResponse:
    existing = enrollment.load_binding(vendor, event.session_id)
    if existing is not None:
        loaded = _load_session(event, vendor)
        if loaded is None:  # pragma: no cover - guarded by existing
            raise RuntimeError("session binding disappeared")
        _, repo, _, _, manifest, audit = loaded
        try:
            event.cwd.relative_to(repo)
        except ValueError as error:
            raise ValueError(
                "repeated SessionStart changed the bound repository"
            ) from error
        audit.append(
            round_number=enrollment.block_count(Path(existing.state_dir)),
            kind="session",
            data={
                "event": "session_start_reentry",
                "source": event.source,
                "session_id": event.session_id,
                "repo": str(repo),
                "protected_files": len(manifest.entries),
                "baseline_preserved": True,
            },
        )
        return HookResponse(ALLOW)

    policy = enrollment.find_policy(event.cwd)
    if policy is None:
        return HookResponse(ALLOW)

    repo = Path(policy.repo).resolve(strict=True)

    if event.source in enrollment.CONTINUATION_SOURCES:
        refusal = _unbound_continuation(event, vendor, repo)
        if refusal is not None:
            return refusal

    state_dir = enrollment.session_state_dir(repo, vendor, event.session_id)
    try:
        state_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError as error:
        raise ValueError(
            "unbound session state already exists; refusing to replace its baseline"
        ) from error
    manifest = freeze(repo, policy.patterns, state_dir)
    enrollment.save_manifest(state_dir, manifest)
    enrollment.save_session_policy(state_dir, policy)
    enrollment.reset_blocks(state_dir)

    census_summary = _take_census_baseline(repo, state_dir, policy)

    audit = AuditChain(state_dir / "logs")
    audit.append(
        round_number=0,
        kind="session",
        data={
            "event": "session_start",
            "source": event.source,
            "session_id": event.session_id,
            "repo": str(repo),
            "protected_files": len(manifest.entries),
            "verifier": list(policy.verifier_argv),
            "census": census_summary,
        },
    )
    enrollment.save_binding(
        enrollment.SessionBinding(
            vendor=vendor,
            session_id=event.session_id,
            repo=str(repo),
            state_dir=str(state_dir.resolve(strict=True)),
            audit_path=str(audit.path.resolve(strict=True)),
        )
    )
    # Both of these are indistinguishable from a real baseline at Stop time,
    # so they have to be said out loud while the session can still be fixed.
    warnings: list[str] = []
    if not manifest.entries:
        audit.append(
            round_number=0,
            kind="warning",
            data={
                "message": NO_PROTECTED_INPUTS,
                "patterns": list(policy.patterns),
            },
        )
        warnings.append(NO_PROTECTED_INPUTS)
    if policy.census and not census_summary["armed"]:
        message = CENSUS_UNSUPERVISED.format(detail=census_summary["detail"])
        audit.append(
            round_number=0,
            kind="warning",
            data={"message": message, "verifier": list(policy.verifier_argv)},
        )
        warnings.append(message)

    if warnings:
        return _system_message("\n\n".join(warnings))
    return HookResponse(ALLOW)


def _take_census_baseline(
    repo: Path, state_dir: Path, policy: enrollment.Policy
) -> dict[str, Any]:
    """Record which acceptance tests exist before the agent touches anything.

    It has to happen here rather than at Stop: a module-level skip planted
    during the session removes tests from collection, so a baseline taken
    afterwards is already the shrunken one.  Enrollment is too early for the
    opposite reason -- the repository moves on between enrolling and a
    session, and a stale baseline would report honestly retired tests as
    missing.
    """
    if not (policy.census and census.is_pytest_verifier(policy.verifier_argv)):
        return {"armed": False, "tests": 0, "detail": "not supervising"}

    report = state_dir / "census-baseline.xml"
    census.clear_report(report)
    try:
        run_verifier(
            census.probe_argv(policy.verifier_argv, report),
            repo,
            policy.timeout,
        )
        collected = census.parse_report(report)
        # The baseline report is a ready-made forgery: a round's report only
        # has to look like it, and the verifier process can read and write
        # this directory.  Nothing needs it after this point.
        census.clear_report(report)
    except Exception as error:  # a probe failure must not block the session
        collected = None
        detail = repr(error)
    else:
        detail = "no report" if not collected else ""

    # A baseline of entries that asserted nothing supervises nothing: pytest
    # abandons the run on a collection error, so the whole report can be one
    # synthetic entry. Arming on that would be silent non-supervision.
    carrying = census.required(collected or {})
    if not carrying and collected:
        detail = "the baseline recorded no test that ran"
        collected = None

    if collected:
        census.save_baseline(state_dir, collected)
    return {
        "armed": bool(collected),
        "tests": len(carrying),
        "detail": detail,
    }


def _unbound_continuation(
    event: HookEvent, vendor: str, repo: Path
) -> HookResponse | None:
    """Refuse to baseline afresh for a continuation TheUstad cannot place.

    De-duplicating on ``vendor + session_id`` covers the continuations that
    keep their id and misses any that do not.  A ``clear`` or ``fork``
    arriving with an unknown id would otherwise freeze the tree *as it now
    stands* -- after the agent has been editing it -- and reset the retry
    counter, which SPEC 4.8a forbids in as many words.  Demonstrated: a
    protected test deleted, then a continuation, and the new baseline had
    four entries where the real one had five.

    Continuing that session properly would mean carrying its manifest, its
    snapshots and its counters across, which the manifest's recorded state
    directory and snapshot paths do not allow to be copied.  So this refuses
    instead: no new baseline is written, ``Stop`` finds no binding and blocks
    through the path that already exists for it, and the operator is told to
    restart rather than being silently unprotected.
    """
    if enrollment.adoptable_state(repo) is None:
        return None  # nothing was running: a genuine first start

    return _system_message(
        f"TheUstad: this {event.source} continues a session that is not bound "
        "to it, and an unfinished baseline already exists for this repository. "
        "Re-freezing now would take the protected inputs as they stand after "
        "editing, and reset the retry counter. No new baseline was created; "
        "restart Claude Code to begin a session TheUstad can verify."
    )


def _retry_exhausted(
    state_dir: Path, audit: AuditChain, blocks: int
) -> HookResponse:
    if enrollment.terminal_verdict(state_dir) is None:
        audit.append(
            round_number=blocks,
            kind="final",
            data={
                "verdict": HookVerdict.RETRY_EXHAUSTED.value,
                "blocks": blocks,
                "verified": False,
            },
        )
        enrollment.mark_terminal(state_dir, HookVerdict.RETRY_EXHAUSTED.value)
    return _system_message(
        "TheUstad FINAL RETRY_EXHAUSTED: the configured verifier never "
        "supported a VERIFIED result. This session is ending with a red, "
        f"non-verified audit verdict. AUDIT_ROOT {audit.root}"
    )


def _verdict(
    claims: Sequence[Claim],
    verification: VerificationResult,
    census_result: census.CensusResult | None = None,
) -> HookVerdict:
    if verification.timed_out:
        return HookVerdict.VERIFIER_TIMEOUT
    # A census failure means the exit code is not evidence, so it cannot
    # carry the round to VERIFIED -- the same rule the wrapper applies.
    if verification.exit_code == 0 and not census_result:
        return HookVerdict.VERIFIED if claims else HookVerdict.PASS_NO_CLAIM
    return HookVerdict.FALSIFIED if claims else HookVerdict.INCOMPLETE


def handle_stop(event: HookEvent, vendor: str) -> HookResponse:
    loaded = _load_session(event, vendor)
    if loaded is None:
        policy = enrollment.find_policy(event.cwd)
        if policy is None:
            return HookResponse(ALLOW)
        return HookResponse(
            BLOCK,
            stderr=(
                "TheUstad: no protected-input baseline is bound to this "
                "session. SessionStart did not run successfully; restart "
                "Claude Code with the user-level hooks enabled."
            ),
        )

    _, repo, state_dir, policy, manifest, audit = loaded
    blocks = enrollment.block_count(state_dir)
    if blocks >= policy.max_blocks:
        return _retry_exhausted(state_dir, audit, blocks)
    round_number = blocks + 1

    if event.background_tasks or event.session_crons:
        verdict = HookVerdict.BACKGROUND_ACTIVE
        audit.append(
            round_number=round_number,
            kind="verdict",
            data={
                "verdict": verdict.value,
                "background_tasks": list(event.background_tasks),
                "session_crons": list(event.session_crons),
            },
        )
        enrollment.bump_blocks(state_dir)
        return HookResponse(
            BLOCK,
            stderr=(
                f"TheUstad verdict: {verdict.value}\n"
                "Background or scheduled session work is still pending, so "
                "verification would race later edits. Wait for it to finish, "
                "then stop again."
            ),
        )

    tampering = check(repo, manifest)
    if tampering:
        response = _record_tampering(
            audit, repo, manifest, round_number, "pre_verifier", tampering
        )
        enrollment.bump_blocks(state_dir)
        return response

    message = event.last_assistant_message
    claims = tuple(find_claims(message))
    audit.append(
        round_number=round_number,
        kind="claim",
        data=_claim_data(message, claims),
    )

    baseline = census.load_baseline(state_dir)
    if policy.census and baseline is None:
        # Either the census never armed, which SessionStart warned about, or
        # the baseline has gone since. Nothing here can tell those apart --
        # that needs the state integrity this does not have yet -- but the
        # round must not simply verify on the exit code with no trace of the
        # difference.
        audit.append(
            round_number=round_number,
            kind="warning",
            data={
                "message": CENSUS_UNSUPERVISED.format(
                    detail="no baseline is bound to this session at Stop"
                ),
                "verifier": list(policy.verifier_argv),
            },
        )

    report = state_dir / f"census-{round_number}.xml"
    census.clear_report(report)
    verification: VerificationResult | None = None
    verifier_error: Exception | None = None
    census_result: census.CensusResult | None = None
    try:
        verification = run_verifier(
            census.report_argv(policy.verifier_argv, report)
            if baseline is not None
            else policy.verifier_argv,
            repo,
            policy.timeout,
        )
    except Exception as error:  # verifier launch failure must fail closed
        verifier_error = error
    else:
        if baseline is not None:
            census_result = census.compare(
                baseline, census.parse_report(report), verification.exit_code
            )

    post = check(repo, manifest)
    if post:
        response = _record_tampering(
            audit, repo, manifest, round_number, "post_verifier", post
        )
        enrollment.bump_blocks(state_dir)
        return response

    if verifier_error is not None:
        verdict = HookVerdict.VERIFIER_ERROR
        audit.append(
            round_number=round_number,
            kind="verdict",
            data={"verdict": verdict.value, "error": repr(verifier_error)},
        )
        enrollment.bump_blocks(state_dir)
        return HookResponse(
            BLOCK,
            stderr=f"TheUstad verdict: {verdict.value}\n{verifier_error!r}",
        )

    if verification is None:  # pragma: no cover - defensive invariant
        raise RuntimeError("verifier produced neither a result nor an error")

    verdict = _verdict(claims, verification, census_result)
    audit.append(
        round_number=round_number,
        kind="verdict",
        data={
            "verdict": verdict.value,
            "verifier_argv": list(verification.argv),
            "verifier_exit_code": verification.exit_code,
            "timed_out": verification.timed_out,
            "claims": len(claims),
            "stop_hook_active": event.stop_active,
            "evidence_tail": list(verification.tail),
            "census": census_result.reason if census_result else None,
            "census_detail": census_result.detail if census_result else "",
        },
    )

    if verdict is HookVerdict.VERIFIED:
        enrollment.reset_blocks(state_dir)
        return _system_message(
            f"TheUstad VERIFIED: explicit completion claim passed the "
            f"protected verifier. AUDIT_ROOT {audit.root}"
        )

    if verdict is HookVerdict.PASS_NO_CLAIM and not policy.require_claim:
        enrollment.reset_blocks(state_dir)
        return _system_message(
            "TheUstad PASS_NO_CLAIM: the verifier passed, but the response "
            "made no explicit completion claim. This is not VERIFIED."
        )

    enrollment.bump_blocks(state_dir)
    evidence = "\n".join(verification.tail) or "Verifier produced no output."
    # Only when the verifier actually reported success: under -x, a collection
    # error or a timeout the exit code is already the failure, and telling the
    # agent the verifier passed sends it after the wrong thing.
    census_decided = bool(census_result) and verification.exit_code == 0
    if census_decided:
        evidence = (
            CENSUS_EVIDENCE.format(
                reason=census_result.reason, detail=census_result.detail
            )
            + "\n\n"
            + evidence
        )
    if verdict is HookVerdict.PASS_NO_CLAIM:
        guidance = "State an explicit completion status only when the task is done."
    elif census_decided:
        guidance = (
            "Make the acceptance tests run again, then state the completion "
            "status."
        )
    else:
        guidance = "Fix the reported failures and continue the task."
    return HookResponse(
        BLOCK,
        stderr=(
            f"TheUstad verdict: {verdict.value}\n"
            f"$ {' '.join(verification.argv)}\n{evidence}\n\n{guidance}"
        ),
    )


HANDLERS = {
    "session_start": handle_session_start,
    "stop": handle_stop,
}


def dispatch(
    vendor: str,
    payload: dict[str, Any],
    *,
    expected_event: str | None = None,
) -> HookResponse:
    parser = ADAPTERS.get(vendor)
    if parser is None:
        raise ValueError(f"unsupported hook vendor: {vendor}")
    event = parser(payload)
    if expected_event is not None and payload["hook_event_name"] != expected_event:
        raise ValueError(
            "hook command event does not match hook_event_name in payload"
        )
    return HANDLERS[event.event](event, vendor)


def _forbidden_argument(argv: Sequence[str]) -> str | None:
    for argument in argv:
        option = argument.split("=", 1)[0]
        if option in FORBIDDEN_POLICY_OPTIONS:
            return option
    return None


def main(argv: Sequence[str]) -> int:
    """Read one event from stdin. Policy arguments are always forbidden."""
    forbidden = _forbidden_argument(argv)
    if forbidden is not None:
        print(
            f"TheUstad: {forbidden} is forbidden at the hook boundary; "
            "policy comes from `theustad.py enroll`.",
            file=sys.stderr,
        )
        return BLOCK
    if len(argv) not in (1, 2):
        print("usage: theustad.py hook <vendor> [SessionStart|Stop]", file=sys.stderr)
        return BLOCK

    vendor = argv[0]
    expected_event = argv[1] if len(argv) == 2 else None
    try:
        payload = json.loads(sys.stdin.read())
        if not isinstance(payload, dict):
            raise ValueError("hook payload must be a JSON object")
        response = dispatch(vendor, payload, expected_event=expected_event)
        # Emitting is inside the guard too: a BrokenPipeError or an
        # unserializable payload here would otherwise escape as exit 1.
        if response.stdout is not None:
            print(json.dumps(response.stdout, sort_keys=True))
        if response.stderr:
            print(response.stderr, file=sys.stderr)
        return response.exit_code
    except Exception as error:
        # Exit 1 is non-blocking in Claude Code, so an unhandled exception here
        # would let the agent stop with no decision rendered.  Every failure,
        # expected or not, must still block.
        try:
            print(
                f"TheUstad hook error: {INTERNAL_ERROR} "
                f"{type(error).__name__}: {error}",
                file=sys.stderr,
            )
        except Exception:  # the stream itself is gone; the exit code still speaks
            pass
        return BLOCK
