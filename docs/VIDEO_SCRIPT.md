# Git4agents: demo video script (about 8 minutes)

**Setup:** Use a 1920×1080 screen. On the left, a browser at `https://madgrix.ygathuku96.workers.dev/board?scenario=cheater` (the repo mall, speed 1×). On the right, a terminal in a clone of the repo with `npm ci` already done. Have `/workspace/live-run-final-4.log` ready to show, or the README "Real numbers" table.
**Rule:** Every claim on screen is either the real live run (green banner "REAL") or explicitly "SIMULATED FROM TEST HARNESS" (amber banner). Say which one is on screen.

---

**[0:00–0:15] Cold open (browser: /board?scenario=cheater, paused)**
> "This is an AI agent trying to cheat. Watch what happens."

**[0:15–0:45] The cheater (press ▶ Play on the Cheater scenario, 1×)**
*Beat 1 lights "Tamperer edits the evaluator", then beat 2 lights red: "QUARANTINED".*
> "This tab is simulated from our test harness. These are the real protocol modules running locally. A contender edited the evaluation files to make its own tests pass. Git4agents doesn't ask anyone whether that's okay. The tamper flag trips, the contender is quarantined, its evidence is marked tainted, and its write token is revoked. Its next push fails with TOKEN_REVOKED."

**[0:45–1:15] The override (beat 3: "Admin override refused")**
> "Now suppose a person, or three verifiers, wants it through anyway. A failed mandatory gate plus a unanimous accept from all three verifiers still comes out REJECT. There is no override button. If the task is escalated to a human, permits are blocked until a new task state is evaluated from scratch. Nobody can wave a cheater through, admins included."

**[1:15–1:30] Title card (README hero)**
> "I'm Yashwanth. This is Git4agents: the trust layer for agent-written code. Agents can write code faster than anyone can review it. We make sure only the exact commit that earned it ever ships."

**[1:30–2:00] The other three refusals (let beats 4–6 play)**
> "A crew claims it's done, but against the wrong baseline. TheUstad, our done-check, says FINAL FALSIFIED, and HEAD doesn't move. Next, another merge moves main after a permit was issued. That permit expires: EXPIRED_HEAD_MOVED. The same SHA is told REBASE_REQUIRED. Once it's rebased into a new SHA with fresh evidence, it promotes. Last beat: twenty-six of twenty-six adversarial trials blocked, zero unauthorized promotions."

**[2:00–2:30] Terminal: prove the simulation is reproducible**
Type: `npm run attack:lab`
> "Don't take the animation's word for it. This is the same attack lab, run live, against the real modules. It ends in ATTACK_LAB_VERIFIED."

**[2:30–2:45] Switch to the "Live run (real)" tab, paused**
> "That was the hostile path. Now the happy path, and this one is real. It's a recorded run on Cloudflare, task 6cdb2087, and every ledger hash on the right is copied straight from its signed bundle."

**[2:45–3:30] Agents in parallel (press ▶; beats 1–7)**
> "First the task is frozen inside a Durable Object, one per task. Three blind verifiers commit to their references before any code exists. That's commit-then-reveal, so they can't fit their judgement to whatever shows up. Then the parent agent forks the repo once, in Cloudflare Artifacts. Two sub-agents claim their lanes: sub-api takes src/api, sub-ui takes src/ui. Every claim lands in the ledger, so each agent knows what the others hold. Their commits land on the shared fork."

**[3:30–4:00] Conflicts (beat 8: "Combine: COMPOSED")**
> "The parent combines the lanes with a per-file three-way merge. When edits don't overlap, you get one COMPOSED commit. If lines overlap, the result is CONFLICTED. Nothing gets written, neither side is dropped, and nothing can be evaluated until a resolver commit exists. In this run the lanes were disjoint, so it composed."

**[4:00–4:30] Queue → Durable Object (beats 9–10)**
> "The push becomes an Artifacts event. It goes through a Cloudflare Queue, at-least-once, and is deduplicated inside the TaskAuthority Durable Object. Being honest: the first combined push wasn't applied, and the harness pushed again. The ledger shows exactly what happened."

**[4:30–5:15] Review by machines that can't be argued with (beat 11: gates light green)**
> "Now evaluation, in a separate domain from the agents. Exact baseline, scope compliance, valid tool states, no eval tampering, complete provenance. Then hidden oracle, regressions, static analysis, semantic checks, security policy and the merge-artifact scan. They're all mandatory, and you can't make up for a failed gate with a high score elsewhere. Then the verifiers reveal and sign their reports."

**[5:15–5:45] Done means verified (beat 12: TheUstad FINAL VERIFIED)**
> "TheUstad checks that the combined commit sits on the frozen baseline with a clean parent. Here it says FINAL VERIFIED. Agents don't get to grade their own 'done'."

**[5:45–6:30] The permit and exact-SHA promotion (beats 13–14)**
> "The verdict is ACCEPT. The authority issues one single-use permit. It's bound to this SHA, fc9c1e7, plus its tree hash, the evidence, the policy and the destination HEAD. A Cloudflare Workflow drives a Container that promotes only that exact commit. If any of those bound values changes, the permit stops working."

**[6:30–7:15] Why: offline verification (beat 15, then terminal)**
> "Last step: VERIFIED, offline."
Terminal: show `cat live-run-final-4.verify.txt`, or `npm run slice` followed by `npm run verify -- --trust-key .slice-output/authority.pub .slice-output/promotion.bundle`.
> "Anyone can take the signed bundle and check it against a pinned public key: the signature, the hash-chained ledger, and the permit id recomputed from its bound fields. You don't have to trust our server. The ledger also records why: the intent, the claims, the evidence, the verdict and the permit."

**[7:15–7:45] Numbers (README "Real numbers" table)**
> "Live: nine of nine steps, three concurrent agents, the promoted SHA equal to the reviewed SHA, VERIFIED. An earlier live run promoted 3b71d3a the same way. Module memory: after an edit, the second pass re-reads 25 of 184 files, 13.6 percent. And the full test suite passes."

**[7:45–8:00] Close (browser: landing page /)**
> "Workers, Durable Objects, Queues, Workflows, Containers and Artifacts. Agents move fast, and only the exact commit that earned it becomes canonical. That's Git4agents, the trust layer for agent-written code. The replay is live at madgrix dot ygathuku96 dot workers dot dev slash replay."
