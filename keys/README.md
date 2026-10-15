# Authority keys

`keys/authority.pub` is the pinned public key for the competition MADGRIX authority.
The matching Ed25519 private key is stored only as the deployed Worker's
`AUTHORITY_SIGNING_KEY` secret and is **not** committed. `TaskAuthority` uses that
private key when finalizing promotion evidence.

`src/cli/verify.ts` trusts this committed public key, or an explicitly supplied
`--trust-key` file, and nothing else. A key embedded in a bundle is compared with the
pinned key; it is never allowed to choose its own trust anchor.

Four recorded live Cloudflare runs produced signed promotion bundles that verified
offline against the pinned authority key. The competition key is a long-lived Ed25519
key; production KMS/HSM/Sigstore lifecycle management remains future hardening.

## Provisioning or rotating the key

Generate the pair outside the repository and never commit the private key:

```bash
openssl genpkey -algorithm ed25519 -out /secure/location/authority.pem
openssl pkey -in /secure/location/authority.pem -pubout -out keys/authority.pub
```

- `authority.pem` (PKCS8) becomes the Worker secret `AUTHORITY_SIGNING_KEY`.
- `keys/authority.pub` (SPKI) is the public trust anchor committed to the repository.
- `src/cli/verify.ts` also accepts SPKI DER as hex and refuses a private-key file as a
  trust key.

Without `AUTHORITY_SIGNING_KEY`, promotion finalization answers 503 and does not
consume the permit, so a successful promotion record cannot be created unsigned.

If the authority key is rotated, update the Worker secret and the pinned public key as
one controlled operation. Historical bundles must be verified with the public key that
was pinned for their authority at the time; do not rewrite old evidence to a new key.

## Live E2E verification

The live runner uses `MADGRIX_TRUST_KEY` when explicitly supplied; otherwise it can use
`keys/authority.pub`. Its preflight fails before creating a task when the trust key is
missing or unreadable.

```bash
npm run verify -- --trust-key keys/authority.pub <promotion.bundle>
```

A successful transcript ends with:

```text
authority key......... PINNED
signature............. VALID
ledger chain.......... OK

VERIFIED
```

## Deployment safety

Never print or commit the private key or Worker service-token values. On the competition
machine, every Worker deploy must preserve the existing private secrets file/bindings.
One deploy without that secrets file removed the service-token bindings and caused a
failed attempt; redeploying with the secrets restored the working Worker.
