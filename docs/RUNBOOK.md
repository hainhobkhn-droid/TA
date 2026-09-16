# Helpa runbook

[SETUP.md](SETUP.md) covers installation. Publishing, grounded replies, team authentication and reporting are implemented locally; provider credentials, approved data and real-account acceptance are required before production use. Detailed setup is in PHASE_1.md, PHASE_2.md, PHASE_3.md and PHASE_4_5.md.

## Health and daily operation

`docker compose ps` shows app/worker/database health. `/healthz` is minimal liveness; `/readyz` checks Postgres. The authenticated System page shows worker heartbeat, queue state counts, exact dry-run operations and the webhook/sync state. `/api/audit` and the Audit page show sensitive changes. Request bodies, URLs, auth headers, OAuth codes and platform response secrets are not written to application logs. Error events carry a request ID.

Use `docker compose logs --tail=80 app worker migrate` for startup/runtime diagnostics. Verify heartbeat freshness (45-second threshold), failed/retry jobs, and channel expiry metadata. Known Page expiry within seven days is highlighted. An absent expiry is unknown unless Meta explicitly returns zero. Token checks and reconnect alerts run in the worker; reconnect manually when invalidated.

## Incident pause and resumption

Settings → Auto-replies paused records the owner preference and audit event. Automatic holding replies obey the same switch. To contain all application activity immediately, run `docker compose stop app worker`, change HELPA_MODE to dry_run in `.env`, then recreate the services after investigation. In-flight requests cannot be recalled. Never set live merely to clear a failed job.

Dry-run permits account OAuth/token exchange and read-only calls, but no customer-facing platform writes. The Phase 0 diagnostic only records its exact payload; it never calls any platform. Publisher/reply transports require global and channel live modes. Unknown remote outcomes must be reconciled before retransmission.

## Backup

Install the maintained `age` CLI through your host's package manager, and generate an age identity on a separate trusted recovery device. Give the VPS only the public recipient. Keep the private identity, AUTH_SECRET and all versions of ENCRYPTION_KEY outside the VPS and outside the database/media backup. PostgreSQL dumps contain confidential customer/business data even though tokens are separately encrypted.

Run:

```sh
export AGE_RECIPIENT='your actual age public recipient'
export BACKUP_DIR='/your/backup/destination'
bash scripts/backup.sh
```

The script stops app/worker briefly, takes a custom-format pg_dump and media tar, records the Git revision/UTC creation time, encrypts the archive and restarts only the services that were running before backup. An already-stopped worker stays stopped. Caddy may return 502 during this maintenance window. Incomplete encrypted output keeps a `.partial` suffix. The temporary plaintext working directory is private and removed on exit; place the host temporary directory on an encrypted filesystem. Only run one backup process at a time.

Schedule nightly using your host scheduler. For example, install a root/operator-readable wrapper that exports the recipient/destination and calls the script from `/opt/helpa`; add a cron entry with `CRON_TZ=Asia/Ho_Chi_Minh` and `15 3 * * * /opt/helpa-backup-wrapper`. Use `flock` in that wrapper to prevent overlap. Configure the host's existing monitoring to alert on a nonzero exit or an archive older than 26 hours. The repository does not install a cron job or connect an alerting account. Copy the encrypted archive off-host after success and verify that copy. Proposed RPO is 24 hours; RTO target is 4 hours, to be measured on your host.

Retain outbound audit for at least 12 months. Audit rows are append-only through SQL triggers; no automatic pruning is implemented. Retention/archive operations need a separately reviewed maintenance procedure. Old backup keys cannot be discarded while any retained archive requires them.

## Restore drill

Use an isolated host/directory and separate Compose project/data volumes. Never run destructive restore commands against the active production database.

1. Obtain the matching application revision, encrypted archive, age private identity and historical auth/encryption keys. Configure a private restore origin, HELPA_MODE=dry_run, and no live external notifications.
2. Create a private temporary directory; decrypt with `age -d -i /secure/recovery-identity -o /private/restore.tar /path/to/archive.tar.age`, then extract the tar there. Verify the recorded revision and inspect the archive members before extraction. Use the trusted matching release.
3. Start only the isolated database with `docker compose -p helpa-restore up -d postgres`. Confirm `docker compose -p helpa-restore ps` targets the isolated project. Do **not** run migrations against an empty schema before restoring.
4. Restore into that empty database:

   ```sh
   docker compose -p helpa-restore exec -T postgres \
     pg_restore -U helpa -d helpa --exit-on-error < /private/restored/database.dump
   ```

5. Restore media with a one-shot container into the isolated media volume:

   ```sh
   docker compose -p helpa-restore run --rm --no-deps -T --entrypoint tar app \
     -C /app/media -xf - < /private/restored/media.tar
   ```

6. Use the preserved AUTH_SECRET and matching ENCRYPTION_KEY/ENCRYPTION_KEY_ID. Run the migration service at the matching revision; checksum verification prevents silently edited migrations. Never point the restored image at the production database.
7. Delete restored browser sessions and expire pending OAuth state/selection in the isolated DB before bringing up the app. Start app only, verify login/TOTP, token decryption using an authorized operator check, audit rows and media references. Do not call Meta until explicitly conducting the account test.
8. Before starting the worker, identify jobs whose external effects may have occurred after the backup. Publisher and reply jobs need reconciliation with remote IDs/evidence. Pending, sending and uncertain operations must be reviewed before workers resume. Hold unresolved operations. Start worker in dry-run, inspect queue/diagnostic, then record elapsed restore time, recovery timestamp and missing records.

Delete plaintext restore material when the drill is complete. Successful file decryption alone is not a restore test. A production failover needs DNS/origin changes, safe queue reconciliation and explicit live reactivation after verification.

## Platform token rotation / disconnect

Reconnect Facebook through Channels. OAuth exchanges a fresh user token for a long-lived token, discovers Pages, and stores the selected Page credential and required upload user token encrypted. A successful reconnect replaces the old encrypted Page credential and resets channel mode to dry-run. Review the actual Page name, scopes, tasks and expiry. Revoke superseded app grants at Meta if appropriate; Helpa disconnect only deletes its own stored token and does not claim to revoke the remote grant.

Meta app secret rotation requires updating META_APP_SECRET on the host, recreating app/worker, then re-running the verified connection. A long-lived Page token is not refreshed through an invented refresh endpoint. The worker checks Page tokens, refreshes TikTok tokens where supported and issues seven-day expiry alerts; see PHASE_3.md.

## Credential encryption-key rotation

Back up the existing key material. Stop app/worker and set HELPA_MODE=dry_run. Generate a new 32-byte hex key and a distinct key ID privately; export them as NEXT_ENCRYPTION_KEY and NEXT_ENCRYPTION_KEY_ID without printing them. Run:

```sh
docker compose run --rm --no-deps -e NEXT_ENCRYPTION_KEY -e NEXT_ENCRYPTION_KEY_ID app \
  node dist/server/server/channels/rotate-key.js --confirm-key-rotation
```

The operator command decrypts/re-encrypts channel credentials and LLM request/response envelopes atomically, discards temporary OAuth selections/states, and appends rotation audit events. It is not an HTTP endpoint. On success, install the new values as ENCRYPTION_KEY and ENCRYPTION_KEY_ID in `.env` **before** recreating app/worker. On transaction failure, leave the old values. Keep the old keys for old backups. Do not rotate AUTH_SECRET using this command: Better Auth sessions/TOTP/recovery data depend on its own secret, so retain it until a separately tested auth-secret migration is available.

## Owner recovery

Use a single-use recovery code from the login challenge if the authenticator is unavailable. Better Auth stores recovery codes encrypted and consumes them; Helpa audits recovery verification. TOTP is required on every new privileged session; trusted-device shortcuts and public signup/password-reset/social-login endpoints are not exposed.

If all codes are lost but the owner still knows the password, an operator with shell/database access can perform an offline MFA reset. Back up, stop app/worker, set HELPA_MODE=dry_run, then run:

```sh
docker compose run --rm --no-deps app node dist/server/server/auth/recover-owner.js \
  --confirm-owner-mfa-reset
```

This appends an operator audit event, removes owner sessions and old MFA enrollment, and leaves the password intact. Recreate app/worker; the owner must enroll TOTP again before business API access. This host-privileged recovery is unavailable through HTTP and is not delegated to normal staff. Verified email-link login and session management are available; owner/manager MFA still applies to passwordless login. Do not create a second owner or edit password hashes manually.

## Meta and TikTok access

Dio reports both apps exist and have access. Do not reapply blindly. Validate the exact redirects/grants on connection and keep denied capabilities disabled. Meta scopes include Page discovery, publishing and messaging; reporting adds optional insights grants. Verify the actual granted scopes and tasks against the phase guides before enabling each operation.

TikTok audit preparation: confirm the actual app purpose is eligible (internal utilities are a documented Direct Post risk), granted scope/account, required creator settings and preview/consent, commercial disclosures, visibility restrictions and status reporting; prepare truthful reviewer instructions/recordings and complete any required audit. Inbox upload has its own grant and human completion; manual export is the baseline when unavailable. The persistent manual state in this release does not mean your existing app grant was denied. [Official reference register](API_NOTES.md).

## Extend a channel

Keep SDK/transport details in channels; implement the ChannelAdapter capabilities and methods; verify official operations and fixtures; start in manual/dry-run; implement signature/dedup and policy before ingestion/replies; use current server authorization, approval, factual checks and one outbound audit boundary. Add real-account contract recordings after access is available. Core feature modules must not call platform HTTP directly.

## Publishing operations

Run migrations with the new image before starting app/worker. Media storage is the existing private volume; ffmpeg/ffprobe are included in the runtime image. For host development, install them and leave their executable names in `.env`, or supply absolute `FFMPEG_PATH`/`FFPROBE_PATH`.

Open Calendar & posts → Pause publishing to stop future publishing dispatches. This is independent of the auto-reply pause. In-flight network calls cannot be recalled. For a hard outage, stop the worker. A draft edit or drag reschedule clears approval. Reapprove the exact revision; the approval names and audit remain retained.

A `would_have_sent` is terminal. To intentionally send it live, duplicate, review the payload, schedule and approve the new revision. Set both HELPA_MODE=live (restart app/worker) and the individual channel's mode to live. Never convert dry-run history into successful live sends.

For `needs_action`, inspect the error and exact revision. An unknown external outcome needs a check in the platform before manual completion. Do not remove `publish_step` records or blindly retry. Confirm the actual permalink when using manual publication. Known successful substeps can be resumed through the resume API; unfinished/unknown substeps block it. Reel processing may take longer than one worker attempt.

### TikTok connection and audit preparation

Register `PUBLIC_URL/api/channels/tiktok/callback` in Login Kit Web. Configure TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET, restart, then Channels → Connect TikTok. Helpa requests video.publish/video.upload and records actual granted scopes. Verify ownership of PUBLIC_URL in TikTok's media URL settings before enabling TIKTOK_URL_OWNERSHIP_VERIFIED. The server generates signed media URLs lasting one hour; no media transfer endpoint is available in global dry-run.

Keep TIKTOK_DIRECT_POST_ELIGIBILITY=unverified until TikTok confirms this internal-use product is eligible and audited. An existing app grant is not this confirmation. Review the official content-sharing checklist: current creator identity, privacy choices without a preset, explicit interaction consent, preview, commercial disclosure, music confirmation and an affirmative export action. Inbox upload requires the creator to finish in the TikTok app. Manual export stays available without a platform token. See PHASE_1.md for remaining acceptance and transport limitations.

## Knowledge, webhooks and escalation

Follow [Front Desk setup](PHASE_2.md) for source mapping, freshness, Google service-account mounts, Meta subscriptions and SMTP. Keep source `updated_at` (and optional product `price_updated_at` / `stock_updated_at`) truthful. Refreshing an old sheet without confirming its contents must not replace timestamps with the import time. Keep the last good version on validation errors. Pause automatic replies before incident investigation; an already approved human reply may still dispatch, so disconnect the channel to stop all channel sends. Unknown reply outcomes require checking the platform before any new manual send.

## Meta review and real-account checklist

Use the existing app's dashboard to verify its current access level; this does not require creating another app or reapplying for already granted access.

1. Confirm app identity, configured business, Page assignment/tasks, public HTTPS domain and exact OAuth redirect. Complete any verification requirements shown by the app dashboard.
2. Confirm the scopes used by each enabled workflow: Page discovery, posts/photos/videos/Reels, engagement/comments, Messenger and Page webhook management. Optional reporting additionally needs insights access. Record the granted set from Helpa Channels.
3. Configure the webhook verification callback and subscribe the target Page to messages/feed. Verify a real incoming message/comment is acknowledged once and appears in the correct channel; repeat delivery must not duplicate the inquiry.
4. Prepare truthful reviewer access instructions and recordings: login with required MFA, Page connection, content preview/approval, publishing, customer inquiry, human escalation and disconnect. Keep credentials out of recordings and public documents.
5. Ensure required public business/app information, privacy and data-deletion instructions are present in the app dashboard. Follow its current review prompts rather than assuming a development token authorizes public customer traffic.
6. Run the live acceptance scenarios only on the intended authorized Page after the dry-run review. Record actual post IDs/permalinks, message IDs, scopes, timestamps and policy outcomes in private acceptance notes. Automated Messenger replies stay within the implemented 24-hour window; Helpa does not use a human-agent tag to extend automation.

## Webhook retry and recovery

Migration 006 adds persistent attempts and a next-attempt timestamp to acknowledged webhook events. Ingestion commits the entire event batch atomically; a failure rolls back its messages and schedules another attempt. The worker makes at most six attempts per cycle with exponential delays of 30, 60, 120, 240 and 480 seconds before retries. Concurrent workers recheck the event state under a row lock, and existing message IDs remain deduplicated.

After the sixth failure the event stays retained as `failed`. The owner can inspect its ID, attempts and timing in System → Delivery & ingestion, fix the cause, then use Retry failed event to start a fresh retry cycle. Requeueing is audited and only works for failed events; it never erases the stored webhook payload or invents a new message ID. Previously failed events from before migration 006 are also available for this recovery action. Raw customer payloads are not exposed in the System response.
