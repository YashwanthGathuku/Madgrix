# Repository-bound artifact verifier

Base: competition/artifact-verifier at 24d43d439b7d97e3915f421ffa60e8e2a1299822.

## Command

Node 24 and Git are required for the production command:

```sh
node scripts/verify-artifact.mjs --repo /path/to/repo --commit FULL_SHA --bundle /path/to/promotion.bundle --trust-key /path/to/authority.pub --expected-destination REPOSITORY_ID --expected-policy POLICY_SHA256 --expected-base DESTINATION_BASE_SHA --json
```

Receiver expectations must come from trusted configuration, not from automatic extraction from the bundle. The expected base is the destination HEAD bound before promotion, not today's remote HEAD. Use a trusted verifier checkout, not candidate-modified verifier code.

## Checks

The production command reuses src/cli/verify.ts for pinned-key signature, policy and ledger verification, and src/lib/tree-digest.ts for tree-digest/v1. It additionally checks a unique authority, receiver destination/policy/base, exact candidate SHA, uniquely passing test-result identity, actual Git object hashes, actual blob/mode/path digest, destination/baseline ancestry and first-parent identity.

It does not execute candidate code, install dependencies, run hooks, follow symlink targets, update refs, publish, or deploy. Git replacement refs and inherited GIT_* overrides are disabled. Shallow repositories, legacy grafts, gitlinks and invalid UTF-8 paths fail closed. Binary blobs, executable modes and symlink blob bytes are supported.

## Scope and limits

Acceptance applies to committed Git objects only. Dirty working directories are not checked. Tests are not rerun. Current remote refs are not checked. Signed evaluation statements still require trust in the authority. This is not a full local authority backend, a correctness proof, or an independent proof of global permit single-use.

Limits: 32 MiB per object, 64 MiB aggregate blob bytes, 10,000 tree entries, 8 MiB listing buffer and 15 seconds per Git subprocess. This is not a comprehensive denial-of-service or malicious-Git-binary audit.

Exit codes: 0 acceptance; 1 refusal; 2 usage/input/runtime setup error.

## Verification status

The 19 focused tests passed with actual Git repositories and real Ed25519 signatures on Node 20.20.1 and Git 2.53.0. The test dependencies use a narrower signature verifier and a reference digest, NOT the full production ledger verifier. Production imports are loaded only for CLI execution.

The production CLI, recorded live bundle, TypeScript checks and full repository suite have NOT been executed in the preparation environment, which lacks Node 24. No cloud deployment is required for this read-only addition.

Run in the actual checkout:

```sh
node --test test/verify-artifact.test.mjs
npm run typecheck
npm test
node scripts/verify-artifact.mjs <required arguments with a recorded live bundle>
```

The existing npm test glob selects .test.ts, so the new .test.mjs suite must be run explicitly. No existing scripts, signing formats, authority code or deployment files are modified.

Rollback: remove only scripts/verify-artifact.mjs, test/verify-artifact.test.mjs and docs/VERIFY_ARTIFACT.md.
