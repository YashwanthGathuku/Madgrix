# Authority keys

`keys/authority.pub` is the pinned public key of the MADGRIX task authority: the
Ed25519 key whose private half is the Worker secret `AUTHORITY_SIGNING_KEY`, with
which the TaskAuthority signs every promotion bundle at `/promotion/finalize`
(`specs/amendments/authority-signing-v1.md`).

`src/cli/verify.ts` trusts this file, or the file given with `--trust-key`, and
nothing else. The key embedded in a bundle is compared against the pinned key and
never used as a trust anchor.

**No production key is provisioned yet**, so this directory does not contain
`authority.pub`. Until it does, `verify` exits 2 unless `--trust-key` is given.
The local slice signs with a key generated per run and pins it with
`--trust-key .slice-output/authority.pub`.

## Provisioning

Generate the key pair outside the repository and never commit the private key:

```bash
openssl genpkey -algorithm ed25519 -out /secure/location/authority.pem
openssl pkey -in /secure/location/authority.pem -pubout -out keys/authority.pub
```

- `authority.pem` (PKCS8, `-----BEGIN PRIVATE KEY-----`) becomes the Worker secret
  `AUTHORITY_SIGNING_KEY`, declared in `cloudflare.config.ts`. PEM or the bare
  base64 of the DER both work.
- `keys/authority.pub` (SPKI, `-----BEGIN PUBLIC KEY-----`) is committed. `verify`
  also accepts the SPKI DER as hex, and refuses a file that holds a private key.

Without `AUTHORITY_SIGNING_KEY`, `/promotion/finalize` answers 503 and consumes
nothing, so a promotion is never recorded without its signed ship record.
