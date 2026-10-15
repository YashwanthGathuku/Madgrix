"""Test census: a green exit code is not evidence that the tests ran.

A verifier's exit code can be produced without executing anything the
acceptance suite asserts.  Two ways, both from source files an agent is
meant to edit and which protection therefore cannot see:

* a module-level ``pytest.skip`` in code the protected tests import, which
  removes them from collection while other tests keep the run green; and
* ``os._exit(0)`` on import, which ends the process with status 0 before a
  single assertion runs.

The census records which tests the acceptance suite collected *before* the
agent started, then requires the verification run to account for every one
of them in a structured report written outside the repository.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Sequence

from .verifier import (
    ignores_bytecode_environment,
    interpreter_index,
    launcher_operands,
    scan_interpreter_flags,
)


REPORT_MISSING = "REPORT_MISSING"
REPORT_MISMATCH = "REPORT_MISMATCH"
CENSUS_SHRINK = "CENSUS_SHRINK"
CENSUS_SKIP = "CENSUS_SKIP"

# Both interfaces say the same thing about the same finding, so they say
# it from one place rather than two spellings to keep in agreement.
CENSUS_UNSUPERVISED = (
    "THEUSTAD_WARNING the test census did not arm, so a green exit code is "
    "the only evidence this run has that the acceptance tests ran. Reason: "
    "{detail}. TheUstad can read a verifier that names an interpreter or a "
    "pytest executable, optionally behind env; it cannot locate the command "
    "inside another launcher's options. Spell the verifier out, or pass "
    "--no-census to say this is intended."
)

CENSUS_EVIDENCE = (
    "The verifier reported success, but its own report does not show the "
    "acceptance tests running. A green exit code earned that way is not "
    "evidence. Reason: {reason} -- {detail}"
)
NO_TESTS_EXIT_CODE = 5


@dataclass(frozen=True)
class CensusResult:
    reason: str | None
    detail: str
    missing: tuple[str, ...] = ()
    added: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return self.reason is not None


# pytest installs two console scripts, not one, and a distribution may add a
# version-suffixed spelling of either.
_PYTEST_SCRIPTS = ("pytest", "py.test")


def _is_pytest_token(token: str) -> bool:
    name = PurePath(token).name.lower()
    if name.endswith(".exe"):
        name = name[: -len(".exe")]
    return any(
        name == script or name.startswith(f"{script}-") for script in _PYTEST_SCRIPTS
    )


def is_pytest_verifier(argv: Sequence[str]) -> bool:
    """Report whether this verifier runs pytest, the only adapter we have.

    pytest is looked for anywhere in argv, not only at ``argv[0]``: under
    ``uv run pytest``, ``poetry run pytest`` or ``env pytest`` the launcher
    holds that slot, and reading it alone would leave those verifiers
    unsupervised while the census reported nothing at all.

    When an interpreter is present its own flag scanner answers the question,
    rather than a second reading of the same argv kept here.  ``-m pytest``,
    ``-mpytest`` and ``-Bmpytest`` are one spelling to that scanner and were
    three separate ways through to a hand-written one.

    Neither reading may veto the other.  A bare word among pytest's own
    arguments can match the interpreter search -- ``pytest -k python -m
    smoke`` matches on the ``-k`` expression, and then pytest's ``-m`` marker
    expression reads as an interpreter module named ``smoke``.  Letting that
    decide disabled the census on a valid verifier, so either reading finding
    pytest is enough.

    The cost is a false positive on a command like ``python -m foo -- pytest``,
    where the module is named and is not pytest.  That is the safe direction
    and it is self-correcting: a command that is not pytest writes no report,
    so the census stands down at baseline rather than blocking anything.  A
    false negative is silent, which is the failure this whole check exists to
    avoid.
    """
    index = interpreter_index(argv)
    if index is not None:
        module = scan_interpreter_flags(argv, index + 1).module
        if module and module.split(".")[0] == "pytest":
            return True

    # A pytest executable, possibly behind a launcher whose own `--` ends its
    # options rather than pytest's arguments.  A launcher operand is skipped
    # for the same reason as above: `env --chdir pytest -- pytest` names a
    # directory, not the command.
    operands = launcher_operands(argv)
    return any(
        position not in operands and _is_pytest_token(token)
        for position, token in enumerate(argv)
    )


def canonical_id(module_path: str, name: str) -> str:
    """Return one spelling for a test.

    Both the baseline and the verification run are read from the same report,
    so the two sides agree by construction rather than by translation.
    """
    return f"{module_path}::{name}"


def normalize_report_entry(classname: str | None, name: str | None) -> str | None:
    if not name:
        return None
    return canonical_id(classname or "", name)


def probe_argv(argv: Sequence[str], report: str | Path) -> list[str]:
    """Argv for TheUstad's own baseline measurement, not for acceptance.

    Because this probe never decides a verdict it may be made safe to
    run.  An interpreter that ignores ``PYTHONDONTWRITEBYTECODE`` would write
    bytecode into the protected tree and the probe itself would be reported as
    tampering.  The acceptance run is left exactly as configured.
    """
    probe = list(argv)
    if ignores_bytecode_environment(probe):
        index = interpreter_index(probe)
        if index is not None:
            probe.insert(index + 1, "-B")
    # The probe also asks for a report. Whether one appears is how TheUstad
    # learns that this verifier answers the flag at all, so that a later
    # missing report means something happened rather than that the verifier
    # never wrote one.
    # --maxfail=0 is "no limit", and it comes after whatever the verifier
    # passed, so it neutralises -x or --maxfail=1 however they were spelled.
    # A fail-fast baseline stops at the first failure, and every test after
    # that point is then missing from the census -- which is exactly where a
    # later module-level skip would hide.
    return with_options(
        probe, f"--junit-xml={report}", "-p", "no:cacheprovider", "--maxfail=0"
    )


def _pytest_index(argv: Sequence[str]) -> int:
    """Where pytest's own command begins, past any launcher in front of it.

    An interpreter naming no module is disregarded for the same reason as in
    ``is_pytest_verifier``: in ``pytest -- tests/python`` the match is the test
    path itself, and starting the separator search after it would append the
    reporting flag past pytest's ``--``, where it reads as another path.
    """
    operands = launcher_operands(argv)
    for position, token in enumerate(argv):
        if position not in operands and _is_pytest_token(token):
            return position
    index = interpreter_index(argv)
    if index is not None and scan_interpreter_flags(argv, index + 1).module:
        return index
    return 0


def with_options(argv: Sequence[str], *options: str) -> list[str]:
    """Add pytest options to a verifier, before pytest's ``--`` separator.

    Everything after pytest's ``--`` is a test path rather than an option, so
    an option appended there makes pytest look for a file by that name, exit 4
    and collect nothing -- which stands the census down on a verifier that was
    perfectly valid.  Every option the census adds goes through here, so there
    is one rule rather than one per caller to keep in agreement.

    Not every ``--`` is pytest's.  ``env -- python -m pytest`` has one that
    ends the *launcher's* options, and inserting before it would hand the flag
    to env instead, so only a separator after pytest's command counts.
    """
    argv = list(argv)
    start = _pytest_index(argv)
    for index in range(start, len(argv)):
        if argv[index] == "--":
            return [*argv[:index], *options, *argv[index:]]
    return [*argv, *options]


def report_argv(argv: Sequence[str], report: str | Path) -> list[str]:
    """Add a report to the acceptance run.

    Only a reporting flag is added. It cannot change which tests are
    selected or what they assert, so the verifier remains the oracle.
    """
    return with_options(argv, f"--junit-xml={report}")


def clear_report(path: str | Path) -> None:
    """Remove a report before the run that is supposed to write it.

    The path is derived from the round number, and a round number repeats:
    a VERIFIED round resets the block count, so the next Stop is round 1
    again.  A verifier that dies before pytest writes anything -- which is
    exactly the ``os._exit(0)`` attack -- would otherwise leave the previous
    round's passing report in place to be read as this round's evidence.
    """
    report = Path(path)
    if report.is_symlink():
        report.unlink()
        return
    report.unlink(missing_ok=True)


def parse_report(path: str | Path) -> dict[str, str] | None:
    """Return ``{canonical id: outcome}``, or ``None`` if unusable."""
    report = Path(path)
    if report.is_symlink() or not report.is_file():
        return None
    try:
        root = ElementTree.parse(report).getroot()
    except (ElementTree.ParseError, OSError):
        return None

    outcomes: dict[str, str] = {}
    suites = [root] if root.tag == "testsuite" else root.iter("testsuite")
    for suite in suites:
        for case in suite.iter("testcase"):
            identifier = normalize_report_entry(
                case.get("classname"), case.get("name")
            )
            if identifier is None:
                continue
            outcome = "passed"
            for child in case:
                if child.tag in ("failure", "error", "skipped"):
                    outcome = child.tag
                    break
            outcomes[identifier] = outcome
    return outcomes


# Outcomes a baseline entry can carry while having asserted nothing.  A test
# that was skipped is the repository's own choice; one that errored never ran
# its body, and a collection failure is not a test at all -- pytest writes a
# synthetic entry named after the module, whose id disappears the moment the
# import is fixed.  Requiring either back convicts an agent for repairing the
# thing it was asked to repair.
_NO_ASSURANCE = frozenset({"skipped", "error"})


def required(baseline: dict[str, str]) -> set[str]:
    """The baseline entries that actually carried assurance."""
    return {
        identifier
        for identifier, outcome in baseline.items()
        if outcome not in _NO_ASSURANCE
    }


def compare(
    baseline: dict[str, str],
    report: dict[str, str] | None,
    exit_code: int,
) -> CensusResult:
    """Decide whether the run accounted for the recorded acceptance tests."""
    if report is None:
        return CensusResult(
            REPORT_MISSING,
            "the verifier produced no usable test report, so nothing shows "
            "the acceptance tests ran",
        )

    expected = required(baseline)
    if exit_code == NO_TESTS_EXIT_CODE and expected:
        return CensusResult(
            CENSUS_SHRINK,
            "the verifier collected no tests at all",
            missing=tuple(sorted(expected)),
        )

    missing = tuple(sorted(expected - set(report)))
    if missing:
        return CensusResult(
            CENSUS_SHRINK,
            f"{len(missing)} test(s) recorded at baseline did not run",
            missing=missing,
        )

    # A test the suite ran at baseline and skips now had its assertions
    # removed, whatever the exit code says. One that asserted nothing at
    # baseline -- already skipped, or errored -- is left alone for the same
    # reason it is not required back.
    newly_skipped = tuple(
        sorted(
            identifier
            for identifier, outcome in report.items()
            if outcome == "skipped" and identifier in expected
        )
    )
    if newly_skipped:
        return CensusResult(
            CENSUS_SKIP,
            f"{len(newly_skipped)} test(s) that ran at baseline were skipped",
            missing=newly_skipped,
        )

    unsuccessful = sorted(
        identifier
        for identifier, outcome in report.items()
        if outcome in ("failure", "error")
    )
    if unsuccessful and exit_code == 0:
        return CensusResult(
            REPORT_MISMATCH,
            f"the verifier reported success while {len(unsuccessful)} test(s) "
            "failed in its own report",
        )

    added = tuple(sorted(set(report) - set(baseline)))
    return CensusResult(None, "every recorded acceptance test ran", added=added)


BASELINE_NAME = "census-baseline.json"


def save_baseline(state_dir: Path, baseline: dict[str, str]) -> Path:
    """Record the baseline beside the manifest, for a later process to read.

    The wrapper holds its baseline in memory because one process spans the
    whole run.  Hook mode does not: SessionStart and Stop are separate
    processes, so what SessionStart measured has to survive on disk or Stop
    has nothing to compare against.
    """
    path = state_dir / BASELINE_NAME
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(baseline, indent=2, sort_keys=True), encoding="utf-8"
    )
    temporary.replace(path)
    return path


def load_baseline(state_dir: Path) -> dict[str, str] | None:
    """Read a saved baseline, or ``None`` when the census did not arm.

    A baseline that cannot be read is treated as absent rather than as an
    empty census: an empty mapping would make every test look accounted for.
    """
    path = state_dir / BASELINE_NAME
    if path.is_symlink() or not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not value:
        return None
    if not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        return None
    return value
