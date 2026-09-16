# Local delivery verification — 2026-09-08

Phases 0–5 are implemented as runnable local slices. This report distinguishes local verification from acceptance on Dio's accounts. See [PLAN.md](PLAN.md) and the individual phase guides for exact scope and limits.

## Completed checks

- `npm run typecheck`, `npm test`, `npm run build`, and formatting checks pass. The suite has **130 tests**, including 51 Vietnamese and six English/mixed-language labeled policy fixtures. These fixture labels are supplied to the engine; they are not a measured LLM accuracy score.
- Playwright passes the complete owner/MFA, media/Reel approval, real worker dry-run, knowledge/inbox approval, reporting/advice, phone invitation/login and immediate revocation flow. Reports and overview fit a 390-pixel phone viewport without horizontal overflow. No live SMS is used by this fixture.
- Dependency audit reports zero known vulnerabilities in the installed production dependency tree at verification time.
- Docker rebuild and upgrade from migration 001 through 005 succeed. App, worker and Postgres are healthy. Caddy HTTPS `/readyz` verifies using the exported local CA. The worker heartbeat is fresh. The separate HTTP development preview uses port 3007.
- An encrypted Compose database/media backup restores into an isolated Postgres database with all five migrations and reporting/inbox/team/knowledge tables present. A separate restore of the existing development database preserves all five audit rows exactly. The Compose media archive was empty; this is not a production-sized media recovery benchmark. Temporary restore databases and plaintext drill material were removed.
- Backup preserves service state: a worker stopped before backup remained stopped afterward. It was explicitly restarted after that check. The script excludes macOS metadata from the archive and retains private archive permissions.
- Observed idle Docker memory was approximately 211 MiB across app, worker, database and Caddy. This is a local idle observation, not a VPS capacity or load-test result.

Local operation remains `HELPA_MODE=dry_run`; no actual platform publication, customer reply, paid model evaluation, email or SMS was sent for this delivery.

## Acceptance still requiring real inputs

| Requirement                                         | Needed to verify                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Facebook Page connection and all publishing formats | Actual app credentials, intended Page, public callback and approved live test content; capture real IDs/permalinks    |
| TikTok Direct Post or inbox upload                  | Actual credentials/scopes, owned public media URL and product eligibility; capture status through completion          |
| Grounded multi-intent reply against Dio's sheet     | Approved product/shipping/FAQ records, true timestamps, voice samples and a representative inquiry                    |
| One day of real traffic in dry-run                  | Configured real webhook subscriptions and a 24-hour observation window; inspect all attempted outbound effects        |
| At least 95% intent-set accuracy                    | Dio-approved examples and authorized positive API budget; run the documented live evaluation and retain actual scores |
| Delegate receives email/SMS and acts within scope   | SMTP/Twilio credentials and an intended recipient; local fake-provider authorization tests already pass               |
| 28-day audience/operations comparison               | Granted metrics capabilities and real history; unsupported or missing fields stay unavailable                         |
| Three actionable weekly recommendations             | Sufficient real evidence; the app intentionally creates fewer suggestions when thresholds are unmet                   |
| Production deployment and recovery target           | Actual VPS/domain configuration and an off-host backup destination; follow SETUP.md and RUNBOOK.md                    |

No production facts, voice samples, account credentials or 28-day history have been invented. Platform permission/eligibility gaps retain manual workflows. Interrupted or ambiguous external mutations require reconciliation; they are not retried blindly. Optional S3 storage and expanded platform inventory/backfill remain extensions described in the phase guides.
