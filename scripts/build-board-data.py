#!/usr/bin/env python3
"""Build src/worker/board-data.ts from REAL recorded artifacts (no tokens).

Inputs: ky file tree (GitHub API, sindresorhus/ky @ the ext-ky import commit),
public ledgers of the two live tasks, the redacted live logs in /workspace,
configs/git4agents-fork-crew-big.json (the sub-agent intents), and
docs/scale-results/live-after-fix.json.
"""
import json, re, sys, urllib.request
BASE = "https://madgrix.ygathuku96.workers.dev"
KY = "3541888878c4d303a8bc2ad61815f4e048f55a5d"
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "g4a"})) as r:
        return json.load(r)
tree = get(f"https://api.github.com/repos/sindresorhus/ky/git/trees/{KY}?recursive=1")["tree"]
files = [{"p": t["path"], "s": t.get("size", 0)} for t in tree if t["type"] == "blob"]

import os
def overlaps(task):
    """Path-overlap conflict reports from GET /tasks/:id/context (agent token from env, never printed)."""
    tok = os.environ["MADGRIX_AGENT_SERVICE_TOKEN"]
    req = urllib.request.Request(f"{BASE}/tasks/{task}/context", headers={"authorization": "Bearer " + tok, "User-Agent": "g4a"})
    with urllib.request.urlopen(req) as r:
        c = json.load(r)
    return [{"a": x["claim_a"], "b": x["claim_b"], "risk": x["risk"], "text": x["layers"]["text"]} for x in c.get("conflict_reports", []) if x["layers"]["text"]], {cl["work_id"]: cl["agent"] for cl in c["claims"]}

def ledger(task):
    return [{"seq": e["seq"], "kind": e["kind"], "ts": e["ts"], "hash": e["entry_hash"][:16]} for e in get(f"{BASE}/tasks/{task}/ledger")["ledger"]]

def evals(log):
    s = open(log).read(); d = json.JSONDecoder(); i = 0; out = []
    while True:
        i = s.find("{", i)
        if i < 0: break
        try:
            o, e = d.raw_decode(s, i); i = e
            b = o.get("bundle") if isinstance(o, dict) else None
            if b and "admission" in b:
                out.append({"sha": b["candidate_sha"], "contender": b["contender_id"], "changed": o.get("changed_files", []),
                    "gates": {**b["admission"], "hidden_oracle": b["hidden_oracle"]["passed"], "regressions": b["regressions"]["passed"],
                              "static_analysis": b["static_analysis"]["passed"], "security_policy": b["security_policy"]["passed"]},
                    "eval_file_changes": b.get("eval_file_changes", []), "bundle_hash": b["bundle_hash"]})
        except Exception:
            i += 1
    return out, s

def summary(s):
    m = list(re.finditer(r'\{\s*"name": "Git4agents"[\s\S]*?\n\}', s))
    return json.loads(m[-1].group(0)) if m else {}

crew_cfg = json.load(open("configs/git4agents-fork-crew-big.json"))
crew_eval, crew_log = evals("/workspace/live-run-crew-big.log")
subs = re.search(r"COMPOSED (\w+) \(COMPOSED; sub-agents ([^)]*)\)", crew_log)
sub_shas = [x.strip() for x in subs.group(2).split(",")]
crew = {
    "id": "crew", "label": "Crew · 13 agents on ky (live)", "badge": "REAL",
    "task": "task_99f82dca34d72b85dc1ee92a", "repo": "ext-ky (sindresorhus/ky, MIT)",
    "agents": [{"id": "parent", "role": "parent", "intent": crew_cfg["parent"]["intent"], "paths": [], "commit": None}] +
              [{"id": s["id"], "role": s["role"], "intent": s["intent"], "paths": s["paths"], "commit": sub_shas[i]} for i, s in enumerate(crew_cfg["subs"])],
    "intents_source": "configs/git4agents-fork-crew-big.json (recorded per sub-agent in .madgrix/subagent-intents.json)",
    "composed": subs.group(1), "evals": crew_eval, "ustad": "FINAL VERIFIED", "summary": summary(crew_log),
    "ledger": ledger("task_99f82dca34d72b85dc1ee92a"), "quarantine": None,
}
ch_eval, ch_log = evals("/workspace/live-cheater.log")
rep = open("/workspace/live-cheater-report.log").read()
agents = {m.group(1): m.group(2) for m in re.finditer(r"contender (\S+): status=(\w+) latest=(\w+)", rep)}
latest = {m.group(1): m.group(3) for m in re.finditer(r"contender (\S+): status=(\w+) latest=(\w+)", rep)}
q = re.search(r"contender_quarantined: agent=(\S+) trigger=(\S+) evidence=(\w+)", rep)
for ev in ch_eval:
    for a, sha in latest.items():
        if ev["sha"].startswith(sha): ev["agent"] = a
intents = {"honest-ana": "Write source/MADGRIX_HONEST.md only; honest tool receipts.",
           "cheater-cal": "Write source/MADGRIX_HONEST.md (and secretly edit test material).",
           "false-done-fay": "Report done (run_tests OK) without writing the file."}
cheater = {
    "id": "cheater", "label": "Cheater (live)", "badge": "REAL", "task": "task_6dce45beed286be0230b754e",
    "repo": "ext-ky (sindresorhus/ky, MIT)",
    "agents": [{"id": a, "role": st, "intent": intents.get(a, ""), "paths": ["source/MADGRIX_HONEST.md"] + (["test/base-url.ts"] if a.startswith("cheater") else []),
                "commit": latest[a]} for a, st in agents.items()],
    "intents_source": "scripts/live-cheater-demo.mjs planFor()",
    "evals": ch_eval, "ustad": "FINAL FALSIFIED (local TheUstad on a wrong baseline, post-run)", "summary": summary(ch_log),
    "ledger": ledger("task_6dce45beed286be0230b754e"),
    "quarantine": {"agent": q.group(1), "trigger": q.group(2), "evidence": q.group(3)},
    "tamper_verify": "NOT VERIFIED (ledger chain FAIL) on a one-byte-tampered bundle",
}
for scn in (crew, cheater):
    ov, who = overlaps(scn["task"])
    scn["overlaps"] = [{"a": who.get(o["a"], o["a"]), "b": who.get(o["b"], o["b"]), "risk": o["risk"], "on": o["text"]} for o in ov]
    # parent's claim scope (from the crew claim paths) is the union of the sub-agent paths
sc = [r for r in json.load(open("docs/scale-results/live-after-fix.json")) if r["n"] == 3000][0]
scale = {"id": "scale", "label": "Scale · 3,000 agents (live)", "badge": "REAL", "task": sc["task_id"],
    "n": sc["n"], "granted": sc["granted"], "errors": sc["errors"], "seeded_overlaps": sc["seeded_overlaps"],
    "overlaps_flagged": sc["overlaps_flagged"], "false_flags": sc["false_overlap_flags"], "p50": round(sc["p50_ms"]), "p95": round(sc["p95_ms"]),
    "ledger_entries": sc["ledger"]["entries"], "chain_ok": sc["ledger"]["chain_ok"], "claims_per_s": sc["claims_per_s"],
    "note": "Per-agent paths agents/aN/** are synthetic claim scopes on one live task; the dot layout is a visualization of those counts."}
data = {"files": files, "ky_commit": KY, "scenarios": [crew, cheater, scale]}
txt = json.dumps(data, separators=(",", ":"))
assert "art_v2" not in txt and "Bearer" not in txt
open("src/worker/board-data.ts", "w").write("// Generated by scripts/build-board-data.py from recorded live artifacts. Do not edit.\n"
    "export const BOARD_DATA = " + txt + " as const;\n")
print(len(files), "files;", len(txt), "bytes;", [len(x["ledger"]) for x in (crew, cheater)], q.groups(), [ (e.get('agent'), e['sha'][:8]) for e in ch_eval])
