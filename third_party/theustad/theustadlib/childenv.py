"""Environment hardening shared by every TheUstad-launched child process."""

import os


BYTECODE_VARIABLE = "PYTHONDONTWRITEBYTECODE"


def child_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """Return a child environment that cannot mistake bytecode for tampering.

    Both the agent and a custom verifier routinely run the project's own test
    suite.  CPython then writes ``__pycache__`` bytecode inside the protected
    ``tests/**`` tree, and the very next manifest check reports those files as
    added: an honest round classified as ``TAMPERED``.  The default verifier
    already passes ``-B``; this closes the same hole for every other child
    without relaxing the tamper check, so a *planted* ``.pyc`` is still
    detected as an added protected path.
    """
    environment = dict(os.environ if base is None else base)
    environment[BYTECODE_VARIABLE] = "1"
    return environment
