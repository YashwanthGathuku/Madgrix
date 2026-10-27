# Governed-resolution benchmark — results

Generated 2026-10-18T17:39:47.991Z · Node v22.22.0 · Mergiraf mergiraf 0.20.0 · legacy resolver ee421f0

Correct = the held-out acceptance test passes on the admitted tree. The pipelines never see that test.

## Conflicting scenarios (textual + list)

| Pipeline | Attempts | Admitted | Admitted & correct | False accepts | Refused | Refused but correct |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | 64 | 49 | 12 | 37 (76% of admitted) | 15 | 0 |
| P1 | 64 | 36 | 19 | 17 (47% of admitted) | 28 | 1 |
| P2 | 64 | 19 | 19 | 0 (0% of admitted) | 45 | 1 |

## Clean-merging scenarios (semantic + control)

| Pipeline | Attempts | Admitted | Admitted & correct | False accepts | Refused | Refused but correct |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | 4 | 4 | 2 | 2 (50% of admitted) | 0 | 0 |
| P1 | 4 | 4 | 2 | 2 (50% of admitted) | 0 | 0 |
| P2 | 4 | 2 | 2 | 0 (0% of admitted) | 2 | 0 |

## Every attempt

| Scenario | Strategy | P0 | P1 | P2 |
| --- | --- | --- | --- | --- |
| CTRL-1 | compose | admit ✓ | admit ✓ | admit ✓ |
| CTRL-2 | compose | admit ✓ | admit ✓ | admit ✓ |
| DC-1 | ours | admit ✗ | admit ✗ | refuse ✗ |
| DC-1 | theirs | admit ✗ | admit ✗ | refuse ✗ |
| DC-1 | union | admit ✓ | admit ✓ | admit ✓ |
| DC-1 | markers | refused | refused | refused |
| DC-1 | reference | admit ✓ | admit ✓ | admit ✓ |
| DC-1 | tamper | admit ✗ | refused | refused |
| DC-1 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| DC-1 | mergiraf | refused | refused | refused |
| DC-2 | ours | admit ✗ | admit ✗ | refuse ✗ |
| DC-2 | theirs | admit ✗ | admit ✗ | refuse ✗ |
| DC-2 | union | admit ✗ | admit ✗ | refuse ✗ |
| DC-2 | markers | refused | refused | refused |
| DC-2 | reference | admit ✓ | admit ✓ | admit ✓ |
| DC-2 | tamper | admit ✗ | refused | refused |
| DC-2 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| DC-2 | mergiraf | refused | refused | refused |
| ES-1 | ours | admit ✗ | admit ✗ | refuse ✗ |
| ES-1 | theirs | admit ✗ | admit ✗ | refuse ✗ |
| ES-1 | union | admit ✗ | admit ✗ | refuse ✗ |
| ES-1 | markers | refused | refused | refused |
| ES-1 | reference | admit ✓ | admit ✓ | admit ✓ |
| ES-1 | tamper | admit ✗ | refused | refused |
| ES-1 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| ES-1 | mergiraf | admit ✓ | refused | refused |
| ES-2 | ours | admit ✗ | admit ✗ | refuse ✗ |
| ES-2 | theirs | admit ✗ | admit ✗ | refuse ✗ |
| ES-2 | union | admit ✗ | admit ✗ | refuse ✗ |
| ES-2 | markers | refused | refused | refused |
| ES-2 | reference | admit ✓ | admit ✓ | admit ✓ |
| ES-2 | tamper | admit ✗ | refused | refused |
| ES-2 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| ES-2 | mergiraf | refused | refused | refused |
| IS-1 | ours | admit ✗ | admit ✗ | refuse ✗ |
| IS-1 | theirs | admit ✗ | admit ✗ | refuse ✗ |
| IS-1 | union | admit ✗ | admit ✗ | refuse ✗ |
| IS-1 | markers | refused | refused | refused |
| IS-1 | reference | admit ✓ | admit ✓ | admit ✓ |
| IS-1 | tamper | admit ✗ | refused | refused |
| IS-1 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| IS-1 | mergiraf | refused | refused | refused |
| IS-2 | ours | admit ✗ | admit ✗ | refuse ✗ |
| IS-2 | theirs | admit ✗ | admit ✗ | refuse ✗ |
| IS-2 | union | admit ✗ | admit ✗ | refuse ✗ |
| IS-2 | markers | refused | refused | refused |
| IS-2 | reference | admit ✓ | admit ✓ | admit ✓ |
| IS-2 | tamper | admit ✗ | refused | refused |
| IS-2 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| IS-2 | mergiraf | refused | refused | refused |
| SEM-1 | compose | admit ✗ | admit ✗ | semantic_conflict ✗ |
| SEM-2 | compose | admit ✗ | admit ✗ | semantic_conflict ✗ |
| ST-1 | ours | admit ✗ | refused | refused |
| ST-1 | theirs | admit ✗ | refused | refused |
| ST-1 | union | admit ✓ | admit ✓ | admit ✓ |
| ST-1 | markers | refused | refused | refused |
| ST-1 | reference | admit ✓ | admit ✓ | admit ✓ |
| ST-1 | tamper | admit ✗ | refused | refused |
| ST-1 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| ST-1 | mergiraf | refused | refused | refused |
| ST-2 | ours | admit ✗ | refused | refused |
| ST-2 | theirs | admit ✗ | refused | refused |
| ST-2 | union | admit ✓ | admit ✓ | admit ✓ |
| ST-2 | markers | refused | refused | refused |
| ST-2 | reference | admit ✓ | admit ✓ | admit ✓ |
| ST-2 | tamper | admit ✗ | refused | refused |
| ST-2 | drop-clean | admit ✗ | admit ✓ | admit ✓ |
| ST-2 | mergiraf | refused | refused | refused |

✓ / ✗: the held-out acceptance test passes / fails on the candidate (shown even when the pipeline refused it, if a commit exists).
A lease refusal leaves no commit; "Refused but correct" then uses the same strategy's P0 candidate as a stand-in.

## By resolver behaviour (conflicting scenarios)

| Strategy | P0 admitted (false) | P1 admitted (false) | P2 admitted (false) |
| --- | --- | --- | --- |
| ours | 8 (8) | 6 (6) | 0 (0) |
| theirs | 8 (8) | 6 (6) | 0 (0) |
| union | 8 (5) | 8 (5) | 3 (0) |
| markers | 0 (0) | 0 (0) | 0 (0) |
| reference | 8 (0) | 8 (0) | 8 (0) |
| tamper | 8 (8) | 0 (0) | 0 (0) |
| drop-clean | 8 (8) | 8 (0) | 8 (0) |
| mergiraf | 1 (0) | 0 (0) | 0 (0) |
