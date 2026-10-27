/**
 * Runs one untrusted command and makes sure nothing it started survives.
 * Invoked by sandbox.mjs as `node sandbox-reaper.mjs <spec.json>`; not a CLI.
 *
 * The command runs in its own process group (detached). When it exits, or
 * when the timeout fires, the whole group is killed, and then every process
 * still carrying this run's MADGRIX_SANDBOX_RUN nonce in its environment
 * (for example one that called setsid to leave the group) is killed too.
 * With bubblewrap the command is also in its own PID namespace, so the kernel
 * kills every process in it when the namespace's init exits.
 */
import { spawn } from "node:child_process";
import { openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const nonceVar = `MADGRIX_SANDBOX_RUN=${spec.nonce}`;
const out = openSync(spec.stdoutFile, "w");
const err = openSync(spec.stderrFile, "w");
const child = spawn(spec.argv[0], spec.argv.slice(1), {
	cwd: spec.cwd,
	env: spec.env,
	detached: true,
	stdio: ["ignore", out, err],
});

/** Kill the process group and every process carrying the nonce. */
function reap() {
	try {
		if (child.pid) process.kill(-child.pid, "SIGKILL");
	} catch {}
	for (let round = 0; round < 20; round += 1) {
		let found = 0;
		let entries = [];
		try {
			entries = readdirSync("/proc");
		} catch {
			return;
		}
		for (const name of entries) {
			if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
			let environ;
			try {
				environ = readFileSync(`/proc/${name}/environ`, "latin1");
			} catch {
				continue;
			}
			if (!environ.split("\0").includes(nonceVar)) continue;
			found += 1;
			try {
				process.kill(Number(name), "SIGKILL");
			} catch {}
		}
		if (found === 0) return;
	}
}

let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	reap();
}, spec.timeoutMs);
child.on("error", (error) => {
	clearTimeout(timer);
	writeFileSync(spec.resultFile, JSON.stringify({ status: null, signal: null, timedOut: false, error: error.message }));
	process.exit(0);
});
child.on("exit", (status, signal) => {
	clearTimeout(timer);
	reap();
	writeFileSync(spec.resultFile, JSON.stringify({ status, signal, timedOut, error: null }));
	process.exit(0);
});
