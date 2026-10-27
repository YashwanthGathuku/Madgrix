/**
 * GET / — the Git4agents front page, in the same hand-drawn mall / marquee /
 * receipt style as /board. Self-contained (inline CSS + SVG, no script, no
 * external assets). Every number on it comes from a recorded live run that
 * is also shown on /board (see scripts/build-board-data.py).
 */
export const REPO = "https://github.com/YashwanthGathuku/Git4agents";

export function renderLanding(demoLinks: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Git4agents · governed promotion for software agents</title>
<meta name="description" content="Many agents work in parallel; only one exact commit, checked by gates nobody can override, becomes canonical.">
<style>
:root{--paper:#fbf4e6;--card:#fffaf0;--ink:#3b2f2a;--dim:#7d6c5f;--wood:#6b4529;--wood2:#3e2716;--gold:#ffcf7a;--ok:#4f9d69;--bad:#d2544c;--amb:#e0a43a;--line:#e6d6bd}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "Avenir Next","Nunito","Segoe UI",system-ui,sans-serif}
a{color:#b5643c}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
.wrap{max-width:1120px;margin:0 auto;padding:0 22px}
h2{font:700 30px/1.15 Georgia,"Iowan Old Style",serif;margin:0 0 6px}h2 em{color:#b5643c}.kicker{font:800 11.5px/1 ui-monospace,Menlo,monospace;letter-spacing:3px;color:#9a7b58;text-transform:uppercase;margin-bottom:10px}
section{padding:64px 0}
/* hero */
.hero{background:linear-gradient(#fde9c9,#f6f0e2 70%,var(--paper));padding:0 0 30px;position:relative;overflow:hidden}
.marquee{position:relative;margin:0 auto;width:fit-content;max-width:94vw;padding-top:18px}
.marquee:before,.marquee:after{content:"";position:absolute;top:0;width:3px;height:20px;background:repeating-linear-gradient(#8a6a45 0 4px,transparent 4px 6px)}.marquee:before{left:18%}.marquee:after{right:18%}
.sign{background:linear-gradient(#7a5233,#5e3d24);border:3px solid var(--wood2);border-radius:16px;padding:16px 38px 18px;text-align:center;color:#fff3dc;box-shadow:0 10px 0 #3e271622,0 18px 30px #3e271622;position:relative}
.sign:before{content:"";position:absolute;inset:5px;border-radius:11px;background:radial-gradient(circle,#ffe08a 0 2.4px,transparent 2.8px) 0 0/18px 18px;-webkit-mask:linear-gradient(#000 0 6px,transparent 6px calc(100% - 6px),#000 calc(100% - 6px));mask:linear-gradient(#000 0 6px,transparent 6px calc(100% - 6px),#000 calc(100% - 6px));pointer-events:none}
.sign h1{font:700 clamp(36px,6vw,62px)/1 Georgia,serif;margin:4px 0 6px;letter-spacing:.5px}.sign h1 em{color:var(--gold)}
.sign p{margin:0;color:#f1dcb9;font-size:clamp(15px,2vw,18px)}
.pitch{text-align:center;max-width:760px;margin:26px auto 0;font-size:clamp(17px,2.2vw,21px);line-height:1.5}
.ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:22px}
.btn{display:inline-block;padding:12px 22px;border-radius:12px;font-weight:800;text-decoration:none;border:2.5px solid var(--wood2);box-shadow:0 4px 0 var(--wood2);transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translateY(2px);box-shadow:0 2px 0 var(--wood2)}.btn.a{background:var(--gold);color:var(--wood2)}.btn.b{background:#fff6dc;color:var(--wood2)}.btn.c{background:#4f9d69;color:#fff}
.preview{display:block;margin:34px auto 0;max-width:980px;background:var(--card);border:2px solid var(--line);border-radius:22px;padding:10px;box-shadow:0 20px 40px #3e27161a;text-decoration:none;position:relative}
.preview svg{display:block;width:100%;height:auto}
.preview .peek{position:absolute;right:22px;bottom:18px;background:var(--wood);color:#fff3dc;font-weight:800;font-size:13px;padding:7px 13px;border-radius:999px;border:2px solid var(--wood2)}
/* steps */
.steps{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-top:26px;counter-reset:s}
.step{background:var(--card);border:2px solid var(--line);border-radius:16px;padding:14px 14px 16px;position:relative;counter-increment:s}
.step:nth-child(odd){transform:rotate(-.6deg)}.step:nth-child(even){transform:rotate(.7deg)}
.step:before{content:counter(s);position:absolute;top:-14px;left:14px;width:28px;height:28px;border-radius:50%;background:var(--wood);color:#fff3dc;font:800 14px/28px Georgia,serif;text-align:center;border:2px solid var(--wood2)}
.step svg{width:100%;height:84px;display:block;margin:6px 0 8px}.step h3{font:700 16.5px Georgia,serif;margin:0 0 4px}.step p{margin:0;font-size:13.5px;color:var(--dim)}
/* results as receipts */
.receipts{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:28px}
.rc{background:#fffdf8 repeating-linear-gradient(#fffdf8 0 25px,#fbf4e6 25px 26px);padding:18px 20px 22px;font:13px/1.65 ui-monospace,Menlo,monospace;box-shadow:0 8px 22px #3e27161c;position:relative;border-top:1px solid var(--line)}
.rc:after{content:"";position:absolute;left:0;right:0;bottom:-9px;height:9px;background:radial-gradient(circle at 7px 0,transparent 7px,#fffdf8 7.5px) 0 0/14px 9px repeat-x}
.rc:nth-child(2){transform:rotate(.8deg)}.rc:nth-child(1){transform:rotate(-.7deg)}
.rc h3{font:800 13px ui-monospace,Menlo,monospace;letter-spacing:2px;text-align:center;margin:0}.rc .sub{text-align:center;color:var(--dim);font-size:11px;border-bottom:1.5px dashed var(--line);padding-bottom:8px;margin-bottom:6px;word-break:break-all}
.ln{display:flex;justify-content:space-between;gap:10px}.ln b{font-weight:700}.ok{color:var(--ok)}.bad{color:var(--bad)}.amb{color:#b07a17}
.tot{border-top:1.5px dashed var(--line);margin-top:6px;padding-top:6px;font-weight:800}
/* use + endpoints */
.two{display:grid;grid-template-columns:1.25fr 1fr;gap:26px;margin-top:24px}
.card{background:var(--card);border:2px solid var(--line);border-radius:18px;padding:20px 22px}
.card h3{font:700 19px Georgia,serif;margin:0 0 8px}
pre{background:#2f2621;color:#f6e7cf;border-radius:12px;padding:12px 14px;overflow:auto;font:12.5px/1.55 ui-monospace,Menlo,monospace;margin:8px 0 14px;border:2px solid var(--wood2)}
pre i{color:#bba489;font-style:normal}
ul.ep{list-style:none;padding:0;margin:0}ul.ep li{padding:7px 0;border-bottom:1px dotted var(--line);font-size:14px}ul.ep code{background:#f3e6cf;padding:2px 6px;border-radius:6px}
.honest{background:#f7e9d0;border:2px dashed #cfa76f;border-radius:16px;padding:16px 20px;font-size:14.5px;margin-top:26px}
footer{background:var(--wood);color:#f1dcb9;padding:30px 0;margin-top:40px;border-top:4px solid var(--wood2)}footer a{color:var(--gold)}
.ft{display:flex;gap:18px;justify-content:space-between;flex-wrap:wrap;align-items:center}
@media (max-width:900px){.steps{grid-template-columns:1fr 1fr}.receipts,.two{grid-template-columns:1fr}.step,.rc{transform:none!important}}
@media (max-width:520px){.steps{grid-template-columns:1fr}.sign{padding:14px 18px}}
</style></head><body>
<header class="hero"><div class="wrap">
<div class="marquee"><div class="sign"><h1>Git4agents <em>·</em></h1><p>the trust layer for agent-written code</p></div></div>
<p class="pitch">Many agents work in parallel, but only <b>one exact commit</b>, checked by gates nobody can override, becomes canonical, and every promotion ships a <b>signed bundle you can verify offline</b>.</p>
<div class="ctas"><a class="btn a" href="/board">◆ Walk through the repo mall</a><a class="btn c" href="/board/new">＋ Bring your repo</a><a class="btn b" href="${REPO}">GitHub ↗</a></div>
<a class="preview" href="/board" aria-label="Open the mall board">${MALL_SVG}<span class="peek">open /board →</span></a>
</div></header>

<section id="how"><div class="wrap"><div class="kicker">How it works</div><h2>From a crowd of forks to <em>one</em> canonical commit</h2>
<div class="steps">
<div class="step">${ICON_FORK}<h3>Fork crew claims</h3><p>Agents enroll, fork into isolated Artifacts repos and claim the paths they will touch. Two claims on one shelf are flagged as overlaps.</p></div>
<div class="step">${ICON_GATES}<h3>Checkout gates</h3><p>A separate evaluation domain runs blind eval, hidden tests, regressions and provenance. Verifiers commit, then reveal signed reports.</p></div>
<div class="step">${ICON_GUARD}<h3>Cheaters quarantined</h3><p>Editing eval files, leaving scope or faking "done" fails a mandatory gate. The contender is quarantined on the ledger with its reason.</p></div>
<div class="step">${ICON_PERMIT}<h3>Signed permit promotes</h3><p>A single-use, exact-state permit lets only the reviewed SHA reach canonical history. No override button exists.</p></div>
<div class="step">${ICON_VERIFY}<h3>Verify offline</h3><p>Each promotion ships a signed bundle with a hash-chained ledger. Anyone can check it offline; a one-byte change fails.</p></div>
</div></div></section>

<section id="results" style="background:#f6ecd9"><div class="wrap"><div class="kicker">Proven on the live Worker</div><h2>Receipts, not <em>claims</em></h2>
<div class="receipts">
<div class="rc"><h3>SCALE RUN</h3><div class="sub">task_945b85a1dd635f9d7d55aeb9</div>
<div class="ln"><span>agents claiming</span><b>3,000</b></div><div class="ln"><span>claims granted</span><b class="ok">3,000</b></div><div class="ln"><span>errors</span><b>0</b></div>
<div class="ln"><span>overlaps flagged</span><b class="amb">149 / 149</b></div><div class="ln"><span>false flags</span><b>0</b></div><div class="ln"><span>p50 / p95</span><b>827 / 2,407 ms</b></div>
<div class="ln"><span>throughput</span><b>22.7 claims/s</b></div><div class="ln tot"><span>ledger 3,004 entries</span><b class="ok">chain OK</b></div></div>
<div class="rc"><h3>CREW OF 13 ON KY</h3><div class="sub">task_99f82dca34d72b85dc1ee92a · sindresorhus/ky (MIT)</div>
<div class="ln"><span>parent fork</span><b>1</b></div><div class="ln"><span>path-scoped sub-agents</span><b>12</b></div><div class="ln"><span>overlaps flagged</span><b class="amb">12</b></div>
<div class="ln"><span>gates passed</span><b class="ok">9 / 9</b></div><div class="ln"><span>TheUstad</span><b class="ok">FINAL VERIFIED</b></div><div class="ln"><span>offline verify</span><b class="ok">VERIFIED</b></div>
<div class="ln tot"><span>promoted</span><b class="ok">d5bcf018194b</b></div></div>
<div class="rc"><h3>CHEATER RUN</h3><div class="sub">task_6dce45beed286be0230b754e</div>
<div class="ln"><span>cheater-cal edits test/base-url.ts</span><b class="bad">QUARANTINED</b></div><div class="ln"><span>ledger #19</span><b class="bad">eval_file_modification</b></div>
<div class="ln"><span>false-done-fay</span><b class="bad">hidden tests ✗</b></div><div class="ln"><span>honest-ana</span><b class="ok">9 / 9 gates</b></div>
<div class="ln"><span>offline verify</span><b class="ok">VERIFIED</b></div><div class="ln"><span>one-byte tampered bundle</span><b class="bad">NOT VERIFIED</b></div>
<div class="ln tot"><span>promoted</span><b class="ok">f27946233a53</b></div></div>
</div></div></section>

<section id="use"><div class="wrap"><div class="kicker">How to use it</div><h2>Bring a repo, run agents, <em>check the receipt</em></h2>
<div class="two"><div class="card">
<h3>1 · Bring a repo</h3><p style="margin:0 0 6px">Open <a href="/board/new">/board/new</a>, paste a public GitHub URL and an instruction (demo access key required). The Worker imports it into Artifacts, freezes a task, registers claims and forks one repo per agent, then opens the live mall.</p>
<h3>2 · Run the agent runner locally</h3>
<pre><i># clone, install, and test</i>
git clone ${REPO}.git && cd Git4agents
npm ci && npm test
<i># full protocol locally, no account needed</i>
npm run slice
<i># live fork crew against your Worker (secrets from a file)</i>
set -a; . ./secrets.env; set +a
MADGRIX_BASE_URL=https://&lt;your-worker&gt;.workers.dev \\
MADGRIX_BASELINE_REPO=ext-ky MADGRIX_BASELINE_COMMIT=&lt;sha&gt; \\
MADGRIX_FORK_CREW_CONFIG=configs/git4agents-fork-crew-big.json \\
npm run live:e2e</pre>
<h3>3 · Verify a bundle offline</h3>
<pre>npm run verify -- --trust-key keys/authority.pub docs/bundles/live-cheater.bundle</pre>
</div><div class="card"><h3>Public endpoints (no token)</h3><ul class="ep">
<li><a href="/board"><code>GET /board</code></a> the repo mall: recorded runs + <code>?live=1</code></li>
<li><a href="/board/new"><code>GET /board/new</code></a> import a repo (demo key)</li>
<li><code>GET /tasks/:id/board-state</code> public-safe task state (JSON)</li>
<li><code>GET /tasks/:id/ledger</code> hash-chained ledger (JSON)</li>
<li><code>GET /tasks/:id/attestation/:permit_id/verify</code> permit check</li>
<li><a href="/health"><code>GET /health</code></a> liveness</li>
${demoLinks}
</ul><p style="font-size:13.5px;color:var(--dim);margin:12px 0 0">Every other route needs a service token. See the API table in the <a href="${REPO}">README</a>. Runs on Cloudflare Workers, Durable Objects, Queues, Workflows, Containers and Artifacts (Worker <code>madgrix</code>).</p></div></div>
<div class="honest"><b>Honest limits.</b> The mall's building, walking and crowd are a visualization; agents, files, gates, ledger lines and SHAs are real. The Worker does not run agents itself: agent work comes from the local runners. The 3,000-agent run is a claim-registration load test on one task with synthetic paths, not 3,000 coding agents. Attestation here is a platform-level permit check, not full in-toto/Sigstore.</div>
</div></section>
<footer><div class="wrap ft"><span><b>Git4agents</b> · Apache-2.0 license · <a href="${REPO}">${REPO.replace("https://", "")}</a></span><span><a href="/board">board</a> · <a href="/board/new">bring a repo</a> · <a href="/health">health</a></span></div></footer>
</body></html>`;
}

const ICON_FORK = `<svg viewBox="0 0 160 84"><path d="M20 70V20M20 40c0 12 30 6 30 22M20 40c0 14 60 4 60 22M20 40c0 16 90 2 90 22" fill="none" stroke="#8a6a45" stroke-width="3"/><circle cx="20" cy="20" r="7" fill="#e07a5f"/><circle cx="50" cy="64" r="6" fill="#3d8eb9"/><circle cx="80" cy="64" r="6" fill="#81b29a"/><circle cx="110" cy="64" r="6" fill="#e9a03b"/><rect x="118" y="10" width="34" height="22" rx="4" fill="#fff" stroke="#c9a77a" stroke-width="2"/><rect x="122" y="15" width="12" height="12" rx="2" fill="#e0a43a"/><text x="138" y="25" font-size="9" fill="#a1453d" font-weight="800">⚠</text></svg>`;
const ICON_GATES = `<svg viewBox="0 0 160 84"><g stroke="#c9a77a" stroke-width="2"><rect x="8" y="30" width="44" height="36" rx="6" fill="#f2cc8f"/><rect x="58" y="30" width="44" height="36" rx="6" fill="#b8d8c8"/><rect x="108" y="30" width="44" height="36" rx="6" fill="#c9d6ea"/></g><g fill="#4f9d69"><circle cx="30" cy="20" r="6"/><circle cx="80" cy="20" r="6"/><circle cx="130" cy="20" r="6"/></g><g font-size="8.5" font-weight="800" fill="#3b2f2a" text-anchor="middle"><text x="30" y="52">blind</text><text x="80" y="52">hidden</text><text x="130" y="52">proven.</text></g></svg>`;
const ICON_GUARD = `<svg viewBox="0 0 160 84"><rect x="70" y="18" width="82" height="58" rx="6" fill="#f7e1dc" stroke="#d2544c" stroke-width="2.5"/><text x="111" y="34" font-size="8" font-weight="800" fill="#a1453d" text-anchor="middle">QUARANTINE</text><path d="M74 60l74-20M74 44l74 22" stroke="#f2c230" stroke-width="5" stroke-dasharray="7 5"/><g transform="translate(36 52)"><circle cy="-22" r="7" fill="#f3c9a5"/><rect x="-8" y="-15" width="16" height="22" rx="6" fill="#4f7cac"/><rect x="-9" y="-31" width="18" height="5" rx="2" fill="#2f3b52"/></g><g transform="translate(96 66)"><circle cy="-18" r="5" fill="#f3c9a5"/><rect x="-6" y="-13" width="12" height="15" rx="5" fill="#b56576"/></g></svg>`;
const ICON_PERMIT = `<svg viewBox="0 0 160 84"><rect x="14" y="14" width="74" height="56" rx="6" fill="#fffaf0" stroke="#c9a77a" stroke-width="2"/><g stroke="#d8c4a2" stroke-width="2"><path d="M24 30h52M24 40h44M24 50h48"/></g><circle cx="74" cy="60" r="11" fill="#d2544c"/><path d="M69 60l4 4 7-8" stroke="#fff" stroke-width="2.5" fill="none"/><g transform="translate(124 50)"><rect x="-22" y="-10" width="44" height="20" rx="7" fill="#e07a5f"/><rect x="-12" y="-18" width="22" height="10" rx="4" fill="#e07a5f"/><circle cx="-12" cy="10" r="4" fill="#333"/><circle cx="12" cy="10" r="4" fill="#333"/></g><text x="124" y="80" font-size="8" font-family="monospace" text-anchor="middle" fill="#3b2f2a">exact SHA</text></svg>`;
const ICON_VERIFY = `<svg viewBox="0 0 160 84"><path d="M30 8h60v66l-6-4-6 4-6-4-6 4-6-4-6 4-6-4-6 4-6-4-6 4z" fill="#fffdf8" stroke="#d8c4a2" stroke-width="2"/><g stroke="#d8c4a2" stroke-width="2"><path d="M38 22h44M38 32h36M38 42h40M38 52h30"/></g><circle cx="118" cy="40" r="22" fill="#dcefdc" stroke="#4f9d69" stroke-width="3"/><path d="M107 40l8 8 15-16" stroke="#4f9d69" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`;

// A small hand-drawn isometric mall used as the hero preview (static SVG).
const MALL_SVG = (() => {
	const P = (x: number, y: number) => [(x - y) * 0.6 + 470, (x + y) * 0.3 + 70];
	const s = (a: number[][]) => a.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
	const up = (q: number[], h: number) => [q[0], q[1] - h];
	const box = (x: number, y: number, w: number, d: number, H: number, top: string, l: string, r: string) => {
		const A = P(x, y), B = P(x + w, y), C = P(x + w, y + d), D = P(x, y + d);
		return `<polygon points="${s([P(x + 6, y + 6), P(x + w + 18, y + 6), P(x + w + 18, y + d + 12), P(x + 6, y + d + 12)])}" fill="#3b2f2a" opacity=".12"/>` +
			`<polygon points="${s([D, C, up(C, H), up(D, H)])}" fill="${l}" stroke="#0001"/><polygon points="${s([B, C, up(C, H), up(B, H)])}" fill="${r}" stroke="#0001"/><polygon points="${s([up(A, H), up(B, H), up(C, H), up(D, H)])}" fill="${top}" stroke="#0001"/>`;
	};
	const aw = ["#e07a5f", "#81b29a", "#3d8eb9", "#e9a03b", "#b56576", "#5fa8a0"];
	let g = `<svg viewBox="0 0 940 420" role="img" aria-label="Illustrated isometric repo mall"><defs><linearGradient id="gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cfe8f3" stop-opacity=".6"/><stop offset="1" stop-color="#9fc7da" stop-opacity=".2"/></linearGradient></defs>`;
	g += `<polygon points="${s([P(-40, -30), P(760, -30), P(760, 520), P(-40, 520)])}" fill="#dfe9cf"/>`;
	g += box(0, 0, 640, 440, 8, "#f5e7cd", "#d9c19c", "#cdb48f");
	g += `<polygon points="${s([up(P(0, 0), 8), up(P(640, 0), 8), up(P(640, 0), 120), up(P(0, 0), 120)])}" fill="#efd9b8" stroke="#c9ad86"/><polygon points="${s([up(P(0, 0), 8), up(P(0, 440), 8), up(P(0, 440), 120), up(P(0, 0), 120)])}" fill="#e4c9a2" stroke="#c9ad86"/>`;
	for (let u = 20; u < 620; u += 44) g += `<polygon points="${s([up(P(u, 0), 70), up(P(u + 32, 0), 70), up(P(u + 32, 0), 104), up(P(u, 0), 104)])}" fill="${(u / 44) % 3 < 2 ? "#ffe3a3" : "#d8e6ea"}" stroke="#b99a70"/>`;
	for (let v = 24; v < 420; v += 44) g += `<polygon points="${s([up(P(0, v), 70), up(P(0, v + 32), 70), up(P(0, v + 32), 104), up(P(0, v), 104)])}" fill="${(v / 44) % 2 < 1 ? "#ffe7b0" : "#d8e6ea"}" stroke="#b99a70"/>`;
	const shops = [[60, 40], [250, 40], [60, 170], [250, 170], [60, 300], [250, 300]];
	shops.forEach(([x, y], i) => {
		const H = [52, 38, 38, 66, 38, 30][i];
		g += box(x, y, 160, 70, H, "#fff7e8", i === 5 ? "#ddd2c4" : "#fdf1dc", "#ecd8b8");
		for (let k = 0; k < 8; k++) {
			const a = up(P(x + k * 20, y + 70), H - 12), b = up(P(x + k * 20 + 20, y + 70), H - 12), c = up(P(x + k * 20 + 20, y + 76), H - 18), d = up(P(x + k * 20, y + 76), H - 18);
			g += `<polygon points="${s([a, b, c, d])}" fill="${k % 2 ? "#fffaf0" : aw[i]}"/>`;
		}
		for (let k = 0; k < 4; k++) {
			const a = up(P(x + 12 + k * 38, y + 70), 4), b = up(P(x + 42 + k * 38, y + 70), 4), c = up(P(x + 42 + k * 38, y + 70), H - 16), d = up(P(x + 12 + k * 38, y + 70), H - 16);
			g += `<polygon points="${s([a, b, c, d])}" fill="${i === 5 ? "#9a8f84" : i === 3 || i === 0 ? "#ffd987" : "#d8e8ee"}" stroke="#a88a64" stroke-width=".8"/>`;
		}
		if (i === 5) g += `<polygon points="${s([up(P(x + 6, y + 70), H * 0.3), up(P(x + 154, y + 70), H * 0.75), up(P(x + 154, y + 70), H * 0.75 + 5), up(P(x + 6, y + 70), H * 0.3 + 5)])}" fill="#f2c230" stroke="#3b2f2a" stroke-dasharray="5 5"/>`;
		if (i === 3) { const f = up(P(x + 140, y + 10), H); g += `<path d="M${f[0]} ${f[1]}v-22l14 4-14 5" fill="#e07a5f" stroke="#7a5c3c" stroke-width="1.5"/>`; }
	});
	g += box(450, 120, 120, 50, 22, "#fff", "#f2cc8f", "#e9dcc6") + box(450, 200, 120, 50, 22, "#fff", "#b8d8c8", "#e9dcc6") + box(450, 280, 120, 50, 22, "#fff", "#c9d6ea", "#e9dcc6");
	g += `<polygon points="${s([up(P(430, 100), 150), up(P(620, 100), 150), up(P(620, 360), 150), up(P(430, 360), 150)])}" fill="url(#gl)" stroke="#7fa9bd"/>`;
	const ppl = [[150, 125, "#e07a5f"], [175, 128, "#3d8eb9"], [330, 255, "#81b29a"], [140, 385, "#e9a03b"], [430, 150, "#8e7dbe"], [430, 230, "#b56576"], [600, 410, "#4f7cac"]];
	ppl.forEach(([x, y, c]) => { const q = P(x as number, y as number); g += `<g transform="translate(${q[0]} ${q[1] - 8})"><ellipse cx="2" cy="12" rx="7" ry="2.4" fill="#0003"/><rect x="-6" y="-8" width="12" height="14" rx="5" fill="${c}"/><circle cy="-13" r="5.5" fill="#f3c9a5"/></g>`; });
	const car = P(700, 300);
	g += `<g transform="translate(${car[0]} ${car[1]})"><rect x="-20" y="-11" width="40" height="20" rx="7" fill="#e07a5f"/><rect x="-12" y="-18" width="22" height="10" rx="4" fill="#e07a5f"/><circle cx="-12" cy="9" r="4" fill="#333"/><circle cx="12" cy="9" r="4" fill="#333"/></g>`;
	return g + "</svg>";
})();
