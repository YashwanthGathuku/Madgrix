# Cloudflare Artifacts — setup status (2026-10-01)

## Done
- `cf` CLI 1.0.0-beta.10 installed, OAuth-authenticated as <owner-email>
  (account `<CLOUDFLARE_ACCOUNT_ID>`).
- Artifacts namespace `default` (jurisdiction `unrestricted`) created.
- Repository `starter-repo` created via `cf artifacts namespaces repos create`.
- `README.md` pushed to `main` via repo token (transient auth header, token never
  in remote URL / git config / logs).
- Cloned separately into a fresh directory; verified commit `28ddbb8` and exact
  README contents.
- No deployment made. No billing settings changed. No local server running.

## Non-secret remote
`https://<CLOUDFLARE_ACCOUNT_ID>.artifacts.cloudflare.net/git/default/starter-repo.git`

## Repo token
Minted at creation; stored at `/tmp/repo-create.json` (mode 600, ephemeral).
Move it to a password manager, then delete the file:
`python3 -c "import json; print(json.load(open('/tmp/repo-create.json'))['token'])"`

## Safe future pushes
```bash
TOKEN='<from password manager>'
git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin main
unset TOKEN
```
Never put the token in the remote URL or `.git/config`. List tokens:
`cf artifacts namespaces repos tokens list --namespace default --name starter-repo`.

## Known local limitation
`workerd` cannot do outbound TLS through this sandbox's egress proxy
(`WRONG_VERSION_NUMBER`), so Workers using the *remote* Artifacts binding can't
run here. The `cf` CLI works because it honors the proxy. On any machine with
direct egress, `dev: { remote: true }` works as documented.
