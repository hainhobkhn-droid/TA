# Set up Helpa on your existing VPS/domain

This guide assumes a Linux VPS with at least 2 vCPU / 4 GB RAM, Docker Engine with the Compose plugin, SSH access, and control of your DNS. It does not provision a host or modify your domain. Commands run in the repository unless noted. Use the OS vendor's supported Docker installation procedure if Docker is not installed.

## Production setup (12 steps)

1. Point the chosen hostname's A record at the VPS. Add an AAAA record only if IPv6 reaches this host. Allow inbound 80/443 and your controlled SSH access. Leave Postgres/app ports private; Compose exposes only Caddy.
2. Copy/clone this repository to a dedicated directory, such as `/opt/helpa`, owned by the deployment operator. Select a reviewed release/commit. Back up an existing installation before upgrading.
3. Generate private secrets without installing Node on the host:

   ```sh
   docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app \
     node:22.22.0-bookworm-slim node scripts/setup-env.mjs
   ```

   This creates `.env` with mode 0600 and refuses to overwrite it. An existing `.env` must be reviewed instead. Keep its contents out of shell transcripts and source control.

4. Edit `.env`: `NODE_ENV=production`, `DOMAIN=your.actual.hostname`, `PUBLIC_URL=https://your.actual.hostname`, `HTTP_PORT=80`, `HTTPS_PORT=443`, and `CADDY_TLS=your-acme-contact@example.com`. Replace the example hostname/email with your own. Retain independent generated AUTH_SECRET, ENCRYPTION_KEY, BOOTSTRAP_TOKEN and POSTGRES_PASSWORD. Compose constructs its internal DATABASE_URL from POSTGRES_PASSWORD.
5. Keep `HELPA_MODE=dry_run`. Optionally provide `META_APP_ID` and `META_APP_SECRET`. OpenAI/Anthropic keys may be added to their respective environment variables, and calls remain disabled until the saved monthly cap is positive. The initial cap is 0; the Settings UI controls the saved cap after owner creation. Do not use a ChatGPT browser/session credential in place of an OpenAI API key.
6. In your existing Meta app, configure the exact valid OAuth redirect `https://your.actual.hostname/api/channels/facebook/callback`. The publisher requests Page selection/publishing/messaging permissions; optional reporting scopes are requested when AUDIENCE_METRICS_ENABLED is enabled. Your existing broader grants are read from token inspection, not assumed from the fact that the app exists. See [API notes](API_NOTES.md) for pinned version and verified operations.
7. Validate then start:

   ```sh
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   ```

   The one-shot migration finishes before app/worker start. Caddy obtains public certificates automatically. Production assets are served by Fastify; Vite is not a production server.

8. Verify `https://your.actual.hostname/healthz` and `/readyz`. Open the root URL; enter the setup token from `.env`, your email, a password of at least 12 characters, your name, and business name. Public signup closes after owner creation. Verify TOTP and save the one-time recovery codes privately.
9. In Channels, connect Facebook and choose the Page. Confirm its actual name, granted permissions and expiry metadata. “No scheduled expiry” is different from a promise the token cannot be revoked. Tokens are encrypted in Postgres and never returned to the UI. Connect TikTok using its exact callback and approved scopes; Direct Post additionally requires verified product eligibility, URL ownership and creator consent. Inbox upload and manual export remain available as described in PHASE_1.md.
10. In System, confirm worker heartbeat and run Verify dry-run. Inspect the exact payload and matching audit entry. In Settings, verify 24/7 coverage, email-only complaint notification policy, post approval requirement and paused auto-replies. A diagnostic is not a real post.
11. Configure nightly encrypted off-host backups and carry out the [restore drill](RUNBOOK.md). Keep AUTH_SECRET and ENCRYPTION_KEY with their key version in a separate secret backup; database/media archives alone cannot recover encrypted tokens and MFA data.
12. Record the deployed commit, verification date, Page/account used and any denied capabilities in your deployment notes. Keep dry-run enabled through real-traffic validation. Follow PHASE_1.md through PHASE_4_5.md to configure knowledge, rules/voice, webhook subscriptions, email, Twilio authentication/digests and optional metrics. Enable live delivery only after reviewing the exact outbound payloads and live acceptance results.

## Local HTTPS

Defaults are `DOMAIN=localhost`, `PUBLIC_URL=https://localhost:8443`, ports 8080/8443, and `CADDY_TLS=internal`. Caddy creates a development CA in its private volume. Export only its public certificate:

```sh
mkdir -p .local
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .local/caddy-root.crt
curl --cacert .local/caddy-root.crt https://localhost:8443/healthz
```

If you choose to trust that local CA for browser use, import `.local/caddy-root.crt` with your OS/browser certificate manager. On macOS this is Keychain Access → import certificate → review the localhost CA → configure trust for development. On Linux use your distribution/browser trust-store procedure. Remove the trust when retiring this development instance. No automatic system trust modification is performed by the repo. Never copy the CA's private key out of the Caddy volume. Public VPS certificates need no local CA trust.

For an HTTP-only local developer preview, use the README's Node workflow with `NODE_ENV=development`. Do not deploy that HTTP preview configuration to the VPS. OAuth callbacks must still match PUBLIC_URL and the approved Meta redirect.

## Changes and upgrades

Environment changes require recreation, not just restart:

```sh
docker compose up -d --force-recreate app worker
```

For a code release: back up, select the reviewed commit, run `docker compose up -d --build`, then verify health and the dry-run diagnostic. Migrations have checksums and an advisory lock; do not edit an applied migration. Add a new migration. A rollback across a schema change needs a compatible image/schema or the isolated restore procedure; never restore an old database under an active live worker.

## Troubleshooting

- App unhealthy: `docker compose logs --tail=80 app migrate`. Do not post logs containing credentials from custom tooling. Helpa omits request bodies/URLs from application logs, so OAuth codes are not logged there.
- No worker heartbeat: inspect `docker compose logs --tail=80 worker`; both processes must share the database and HELPA_MODE. Health considers heartbeat older than 45 seconds stale.
- Certificate failure: check DNS, external ports and stale AAAA records. Internal certificates are for local development only.
- ORIGIN_REJECTED or failed login cookies: browser origin, PUBLIC_URL, reverse proxy and Meta redirect must agree, including any development port. Only the configured origin is accepted for mutations. Do not add wildcard origins.
- Meta permission error: inspect the requested/granted scope and Page assignment in your existing app. Never replace OAuth with delegates sharing the personal Facebook password.
- Database password change: changing POSTGRES_PASSWORD in `.env` does not change an already-initialized database role. Rotate the role password separately, coordinate app configuration, then recreate the services. Do not remove the data volume to fix authentication.
