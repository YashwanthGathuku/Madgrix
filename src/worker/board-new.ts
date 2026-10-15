/**
 * GET/POST /board/new — "open your repo in the mall". A visitor with the demo
 * access key pastes a public GitHub repo URL and an instruction. The Worker
 * (1) imports the repo into Artifacts with the binding's import(), (2) freezes
 * a real task with that instruction via handleCreateTask, (3) enrolls the
 * requested agents and forks one Artifacts repo per agent via
 * handleCreateContender, then redirects to /board?live=1&task=<id>.
 *
 * It does NOT run agents: agent work (claims, commits, evaluation) is done by
 * the local runners (scripts/live-e2e.ts, run-fork-crew.mjs). Agent secrets
 * and fork tokens produced here are discarded and never sent to the browser.
 *
 * Abuse protection: BOARD_DEMO_KEY (Worker secret, constant-time compare),
 * per-IP rate limit (best effort, edge cache), GitHub size cap, 1-3 agents.
 */
export const MAX_REPO_KB = 20000;
const RATE_WINDOW_S = 600;
const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

type Deps = {
	createTask: (env: any, req: Request) => Promise<Response>;
	createContender: (env: any, taskId: string, req: Request) => Promise<Response>;
	claim: (env: any, taskId: string, req: Request) => Promise<Response>;
};

function esc(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

async function eqKey(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	const u = new Uint8Array(x), v = new Uint8Array(y);
	let d = 0;
	for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
	return d === 0;
}

const HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
	"cache-control": "no-store",
};

export function renderNewPage(msg = "", ok = false): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Git4agents · open your repo in the mall</title>
<style>body{margin:0;background:linear-gradient(#fde9c9,#f6f0e2);font:15px/1.5 "Avenir Next",Nunito,system-ui,sans-serif;color:#3b2f2a;min-height:100vh;display:grid;place-items:center}
.board{background:linear-gradient(#7a5233,#5e3d24);border:3px solid #3e2716;border-radius:14px;color:#fff3dc;text-align:center;padding:10px 24px;margin-bottom:-10px;position:relative;z-index:1}h1{font:700 24px Georgia,serif;margin:0}h1 em{color:#ffcf7a}
form{background:#fff6dc;border:2px solid #b98f4f;border-radius:10px 26px 26px 10px;padding:26px 28px;width:min(560px,92vw);box-shadow:5px 7px 0 #b98f4f44}
label{display:block;font-weight:700;margin:10px 0 4px}input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1.5px solid #d8c4a2;border-radius:8px;background:#fffdf8}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:9px;background:#4f9d69;color:#fff;font:inherit;font-weight:800;cursor:pointer;box-shadow:0 3px 0 #2f6e44}
.note{font-size:12.5px;color:#8a7a6d;margin-top:12px}.msg{padding:8px 10px;border-radius:8px;margin-bottom:8px;background:${ok ? "#dcefdc" : "#f7d9d5"};color:${ok ? "#2f6e44" : "#a1453d"}}</style></head>
<body><div><div class="board"><h1>Git4agents <em>· open your repo in the mall</em></h1></div>
<form method="post" action="/board/new">${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<label for="repo">Public GitHub repo URL</label><input id="repo" name="repo" required placeholder="https://github.com/owner/repo" pattern="https://github\\.com/.+">
<label for="instruction">Instruction for the agents (frozen as the task intent)</label><textarea id="instruction" name="instruction" rows="3" maxlength="500" required></textarea>
<label for="paths">Paths the agents claim (comma separated, optional)</label><input id="paths" name="paths" placeholder="e.g. readme.md, src/**">
<label for="agents">Agents to enroll &amp; fork</label><select id="agents" name="agents"><option>1</option><option selected>2</option><option>3</option></select>
<label for="key">Demo access key</label><input id="key" name="key" type="password" required autocomplete="off">
<button type="submit">Import, create task &amp; fork → open the live mall</button>
<div class="note">What happens for real: the repo is imported into Cloudflare Artifacts, a task is frozen with your instruction, the agents are enrolled and each gets its own Artifacts fork. Agents do <b>not</b> start working from this page: claims, commits and gate runs come from the agent runners (<code>scripts/live-e2e.ts</code>), and the mall only shows what the authority records. Max repo size ${MAX_REPO_KB / 1000} MB · 1 import per 10 min per IP.</div>
<div class="note"><a href="/board">← back to the mall</a></div></form></div></body></html>`,
		{ status: msg && !ok ? 400 : 200, headers: HEADERS },
	);
}

function randomHex(n: number): string {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function handleNewBoard(env: any, request: Request, deps: Deps): Promise<Response> {
	if (!env.BOARD_DEMO_KEY) return renderNewPage("Repo import is disabled on this deployment (no demo key configured).");
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return renderNewPage("Could not read the form.");
	}
	const repoUrl = String(form.get("repo") ?? "").trim();
	const instruction = String(form.get("instruction") ?? "").trim().slice(0, 500);
	const key = String(form.get("key") ?? "");
	const claimPaths = String(form.get("paths") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_.\/*-]{1,120}$/.test(x)).slice(0, 5);
	if (claimPaths.length === 0) claimPaths.push("**");
	const n = Math.min(3, Math.max(1, parseInt(String(form.get("agents") ?? "2"), 10) || 2));
	if (!(await eqKey(key, String(env.BOARD_DEMO_KEY)))) return renderNewPage("Wrong demo access key.");
	const m = REPO_RE.exec(repoUrl);
	if (!m) return renderNewPage("Only https://github.com/<owner>/<repo> URLs are accepted.");
	if (!instruction) return renderNewPage("Please write an instruction.");

	// Best-effort per-IP rate limit on the edge cache.
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const cache = typeof caches !== "undefined" ? (caches as any).default : null;
	const rlKey = new Request(`https://rate-limit.madgrix.internal/board-new-v4/${encodeURIComponent(ip)}`);
	if (cache && (await cache.match(rlKey))) return renderNewPage("Rate limited: one import per 10 minutes per IP. Try again later.");

	const [, owner, name] = m;
	const gh = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers: { "user-agent": "madgrix-board", accept: "application/vnd.github+json" } });
	if (!gh.ok) return renderNewPage(`GitHub repo not found or not public (${gh.status}).`);
	const meta: any = await gh.json();
	if (meta.private) return renderNewPage("Only public repos.");
	if (typeof meta.size === "number" && meta.size > MAX_REPO_KB) return renderNewPage(`Repo too large (${meta.size} KB > ${MAX_REPO_KB} KB).`);
	if (cache) await cache.put(rlKey, new Response("1", { headers: { "cache-control": `max-age=${RATE_WINDOW_S}` } }));

	const raw: any = env.ARTIFACTS;
	if (!raw || typeof raw.import !== "function") return renderNewPage("Artifacts import is not available in this environment.");
	const slug = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
	const repoName = `ext-${slug}-${randomHex(3)}`;
	let lastErr = "";
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const src: any = { url: `https://github.com/${owner}/${name}.git` };
			if (attempt % 2 === 0 && meta.default_branch) src.branch = meta.default_branch;
			await raw.import({ source: src, target: { name: repoName, opts: { description: `board import of ${owner}/${name}` } } });
			lastErr = "";
			break;
		} catch (e) {
			lastErr = String((e as Error)?.message ?? e).slice(0, 200);
			await new Promise((r) => setTimeout(r, 1500));
		}
	}
	if (lastErr) {
		if (cache) await cache.delete(rlKey); // a failed import does not use up the visitor's slot
		return renderNewPage(`Artifacts import failed: ${lastErr}`);
	}
	// Wait for the import to become readable, then take its HEAD as the frozen baseline.
	let head = "";
	for (let i = 0; i < 30 && !head; i++) {
		try {
			const repo = await raw.get(repoName);
			const log = await repo.log({ limit: 1 });
			const c = Array.isArray(log) ? log[0] : null;
			head = c ? String(c.hash ?? c.sha ?? c.oid ?? c.id ?? "") : "";
		} catch {
			/* still importing */
		}
		if (!head) await new Promise((r) => setTimeout(r, 2000));
	}
	if (!head) return renderNewPage(`Imported ${repoName} but it was not ready within 60 s; try again shortly.`);

	const agent_ids = Array.from({ length: n }, (_, i) => `visitor-${i + 1}`);
	const ctl = { authorization: `Bearer ${env.CONTROL_SERVICE_TOKEN}`, "content-type": "application/json" };
	const tr = await deps.createTask(env, new Request("https://internal/tasks", { method: "POST", headers: ctl, body: JSON.stringify({ intent: instruction, baseline_repo: repoName, baseline_commit: head, agent_ids, behavior_contract: `Imported from ${repoUrl} via /board/new` }) }));
	if (tr.status !== 201) return renderNewPage(`Task creation failed (${tr.status}).`);
	const task: any = await tr.json();
	let forked = 0;
	const forkErrors: string[] = [];
	for (const agent of agent_ids) {
		const secret = task.agent_secrets?.[agent];
		let status = 0, err = "";
		// Same first step the runner takes (scripts/run-contenders.mjs): a claim
		// whose intent is the visitor's instruction, then the fork bound to it.
		const now = new Date();
		const claimInput = { intent: { behavior: [instruction] }, scope: { paths: claimPaths, symbols: [] }, contracts: { reads: [], modifies: [] }, interfaces: [], schema_changes: [], expected_tests: [], agent, task: task.task_hash, baseline: head, lease: { claimed_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString() } };
		const clr = await deps.claim(env, task.task_id, new Request(`https://internal/tasks/${task.task_id}/claim`, { method: "POST", headers: { ...ctl, "x-madgrix-agent-secret": secret }, body: JSON.stringify({ claim: claimInput }) }));
		const clb: any = await clr.json().catch(() => ({}));
		const workId = typeof clb?.work_id === "string" ? clb.work_id : undefined;
		if (!workId) { forkErrors.push(`${agent}:claim:${clr.status}:${String(clb?.error ?? "")}`); continue; }
		for (let attempt = 0; attempt < 4 && !(status >= 200 && status < 300); attempt++) {
			const cr = await deps.createContender(env, task.task_id, new Request(`https://internal/tasks/${task.task_id}/contenders`, { method: "POST", headers: { ...ctl, "x-madgrix-agent-secret": secret }, body: JSON.stringify({ agent_id: agent, claim_work_id: workId }) }));
			status = cr.status;
			// fork credentials are discarded, never shown; keep only the error code
			const b: any = await cr.json().catch(() => ({}));
			err = typeof b?.error === "string" ? b.error : "";
			if (!(status >= 200 && status < 300)) await new Promise((r) => setTimeout(r, 3000));
		}
		if (status >= 200 && status < 300) forked++;
		else forkErrors.push(`${agent}:${status}${err ? ":" + err : ""}`);
	}
	return new Response(null, { status: 303, headers: { location: `/board?live=1&task=${task.task_id}&from=${encodeURIComponent(`${owner}/${name}`)}&forks=${forked}/${n}${forkErrors.length ? "&fork_errors=" + encodeURIComponent(forkErrors.join(",").slice(0, 200)) : ""}`, "cache-control": "no-store" } });
}
