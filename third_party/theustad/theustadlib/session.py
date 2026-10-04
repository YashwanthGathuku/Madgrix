"""Codex agent session execution and JSONL retention."""

import os
import queue
import signal
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from .childenv import child_environment
from .events import extract_agent_text, extract_thread_id, parse_line


DEFAULT_INITIAL_CMD = (
    "codex",
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
)
DEFAULT_RESUME_TEMPLATE = (
    "codex",
    "exec",
    "resume",
    "--json",
    "{thread_id}",
)
TAIL_LINES = 30
TIMEOUT_EXIT_CODE = 124

LineSink = Callable[[str], None]


@dataclass(frozen=True)
class SessionResult:
    argv: tuple[str, ...]
    exit_code: int
    timed_out: bool
    thread_id: str | None
    last_agent_message: str | None
    non_json_tail: tuple[str, ...]
    warnings: tuple[str, ...]


def _read_lines(stream: TextIO, lines: queue.Queue[str | None]) -> None:
    try:
        for line in stream:
            lines.put(line)
    finally:
        lines.put(None)


def _group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _signal_group(process: subprocess.Popen[str], signal_number: int) -> None:
    try:
        os.killpg(process.pid, signal_number)
    except ProcessLookupError:
        pass
    except PermissionError:
        # macOS can report EPERM after a completed leader becomes inaccessible.
        if process.poll() is None:
            raise


def _terminate_process_group(
    process: subprocess.Popen[str], *, grace: float = 0.5
) -> None:
    if os.name == "posix":
        _signal_group(process, signal.SIGTERM)
        deadline = time.monotonic() + grace
        while _group_exists(process.pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        if _group_exists(process.pid):
            _signal_group(process, signal.SIGKILL)
    elif process.poll() is None:
        process.terminate()

    if process.poll() is None:
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                _signal_group(process, signal.SIGKILL)
            else:
                process.kill()
            process.wait(timeout=grace)


def _render_template(
    template: Sequence[str], replacements: dict[str, str]
) -> tuple[list[str], set[str]]:
    rendered: list[str] = []
    used: set[str] = set()
    for argument in template:
        value = argument
        for name, replacement in replacements.items():
            marker = "{" + name + "}"
            if marker in value:
                value = value.replace(marker, replacement)
                used.add(name)
        rendered.append(value)
    return rendered, used


class AgentSession:
    """Start and resume one exact Codex session."""

    def __init__(
        self,
        initial_cmd: Sequence[str],
        resume_template: Sequence[str],
        repo: str | os.PathLike[str],
        timeout: float,
    ):
        if not initial_cmd or not resume_template:
            raise ValueError("agent command templates cannot be empty")
        if timeout <= 0:
            raise ValueError("agent timeout must be positive")

        self.initial_cmd = tuple(initial_cmd)
        self.resume_template = tuple(resume_template)
        self.repo = Path(repo)
        self.timeout = timeout
        self.thread_id: str | None = None
        self.last_agent_message: str | None = None
        self.non_json_tail: tuple[str, ...] = ()
        self.exit_code: int | None = None
        self.timed_out = False
        self.warnings: tuple[str, ...] = ()

    def start(self, task: str, *, on_line: LineSink | None = None) -> SessionResult:
        argv, used = _render_template(self.initial_cmd, {"task": task})
        if "task" not in used:
            argv.append(task)
        return self._run(argv, (), on_line)

    def resume(
        self, message: str, *, on_line: LineSink | None = None
    ) -> SessionResult:
        warnings: tuple[str, ...] = ()
        if self.thread_id is None:
            thread_value = "--last"
            warnings = (
                "Missing thread id; resumed with --last instead of an exact session.",
            )
        else:
            thread_value = self.thread_id

        argv, used = _render_template(
            self.resume_template,
            {"thread_id": thread_value, "message": message},
        )
        if "thread_id" not in used:
            argv.append(thread_value)
        if "message" not in used:
            argv.append(message)
        return self._run(argv, warnings, on_line)

    def _run(
        self,
        argv: list[str],
        initial_warnings: tuple[str, ...],
        on_line: LineSink | None,
    ) -> SessionResult:
        process = subprocess.Popen(
            argv,
            cwd=self.repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
            start_new_session=os.name == "posix",
            env=child_environment(),
        )
        if process.stdout is None:
            _terminate_process_group(process)
            raise RuntimeError("agent output pipe was not created")

        lines: queue.Queue[str | None] = queue.Queue()
        reader = threading.Thread(
            target=_read_lines,
            args=(process.stdout, lines),
            daemon=True,
        )
        reader.start()

        evidence: deque[str] = deque(maxlen=TAIL_LINES)
        self.last_agent_message = None
        deadline = time.monotonic() + self.timeout
        timed_out = False

        def consume(raw_line: str) -> None:
            line = raw_line.rstrip("\r\n")
            if on_line is not None:
                on_line(line)
            event = parse_line(line)
            if event is None:
                evidence.append(line)
                return

            event_thread_id = extract_thread_id(event)
            if self.thread_id is None and event_thread_id is not None:
                self.thread_id = event_thread_id
            agent_text = extract_agent_text(event)
            if agent_text is not None:
                self.last_agent_message = agent_text

        try:
            while process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    line = lines.get(timeout=min(0.05, remaining))
                except queue.Empty:
                    continue
                if line is not None:
                    consume(line)
        finally:
            normal_exit_code = process.poll()
            _terminate_process_group(process)

        reader.join(timeout=1)
        while True:
            try:
                line = lines.get_nowait()
            except queue.Empty:
                break
            if line is not None:
                consume(line)

        warnings = list(initial_warnings)
        if timed_out:
            timeout_warning = f"AGENT_TIMEOUT after {self.timeout:g} seconds"
            evidence.append(timeout_warning)
            if on_line is not None:
                on_line(timeout_warning)
            warnings.append(timeout_warning)
            exit_code = TIMEOUT_EXIT_CODE
        else:
            exit_code = normal_exit_code
            if exit_code is None:
                exit_code = process.returncode

        self.exit_code = exit_code
        self.timed_out = timed_out
        self.non_json_tail = tuple(evidence)
        self.warnings = tuple(warnings)
        return SessionResult(
            argv=tuple(argv),
            exit_code=exit_code,
            timed_out=timed_out,
            thread_id=self.thread_id,
            last_agent_message=self.last_agent_message,
            non_json_tail=self.non_json_tail,
            warnings=self.warnings,
        )
