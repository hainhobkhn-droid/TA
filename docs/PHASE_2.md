# Front Desk delivery

Local implementation, 2026-09-08. Real-account acceptance remains open until Dio supplies approved data, voice samples, API credentials and a public webhook domain.

## Use it

1. In Knowledge, create a built-in source or select CSV, XLSX, published Google CSV or private Sheets API. Each dataset has a maximum age. The products header is in `docs/knowledge/products.example.csv`; all datasets require an explicit ISO 8601 `updated_at` with timezone.
2. Upload a file, review rows and map canonical fields to source columns. Approve the import. Any schema error rejects the entire import, preserving the last successful version. Built-in records have the same validation and version history.
3. For private Sheets, share the sheet with a service account as Viewer, enable the Sheets API, mount its JSON file read-only into both app and worker, and set `GOOGLE_SERVICE_ACCOUNT_FILE` to that container path. Enter spreadsheet ID and an explicit bounded range. No domain delegation is needed. For published CSV, use Google's published `/spreadsheets/d/e/.../pub?output=csv` URL. Only public sheets belong in this mode.
4. Sync once to approve the mapping and activate polling. `KNOWLEDGE_POLL_MINUTES` defaults to 10. Polling imports subsequent valid changes as business-approved source content; limit edit access to your Sheet accordingly. Original timestamps remain authoritative. An unchanged old record remains old.
5. In Rules, review the versioned YAML. Complaints cannot become automatic replies or generate SMS/in-app alerts. Voice samples can be pasted as Markdown; they remain reference material and do not establish product facts. Automatic output uses typed templates and immutable source fields.
6. In Inbox, paste a manual inquiry. Inspect its intents, language, confidence, exact facts and source versions. Without a configured model/key/cap, the conservative classifier always requires human review. Approve or edit the draft; the worker records an exact dry-run operation. Live manual threads provide a copyable reply and never claim it was sent.
7. Enable automatic replies in Settings only when ready. Holding replies obey the pause switch. Automatic and unchanged grounded drafts are checked again for source revisions/freshness at dispatch. Messenger replies also require a customer message within the preceding 24 hours.

## Providers and operational behavior

The gateway supports API-key OpenAI Responses and Anthropic Messages with strict JSON-schema validation. Model rates are allowlisted in code for `gpt-5-mini` and `claude-haiku-4-5` (plus documented snapshots). Unknown model rates, missing keys, zero/exhausted cap, invalid output and provider failures fall back to human review. The model classifies/extracts; it cannot invent final customer facts. Requests/responses are envelope-encrypted, phone spans are redacted from classification input, and usage is retained. Conservative reservations are serialized per business and retained for the Vietnam calendar month, including uncertain calls; the spend limit can stop calls before actual billed usage reaches the cap. It is not an account-wide provider billing limit.

Meta callback: `PUBLIC_URL/webhooks/meta`. Set an independent `META_WEBHOOK_VERIFY_TOKEN` and the existing app secret. Configure Page `messages` and `feed` subscriptions and subscribe the Page using your approved Meta app. Reconnect the Page for `pages_messaging`, `pages_manage_metadata` and other displayed missing scopes. Raw signatures are verified before durable acknowledgement; webhook-body and external-message IDs deduplicate retries. The worker normalizes Messenger messages and added Page comments. Echoes do not start another reply. Attachments require human review. No message-tag or human-agent policy exception is used for automated responses.

TikTok DM/comment access remains a manual workflow until the relevant Business Messaging capability is verified. Existing Content Posting grants do not imply that capability.

Configure SMTP and `MAIL_FROM` for email escalation. Both `HELPA_MODE=live` and `NOTIFICATION_MODE=live` are required to send notifications; otherwise exact notification intent is recorded. SMTP requires TLS. Complaint rows are database-constrained to email only. The assigned inbox conversation remains visible. Ambiguous external delivery outcomes are held for operator reconciliation, never blindly retried. Inspect pending/uncertain notifications via System API; missing SMTP configuration leaves mail pending.

System exposes scoped last inbound-message timestamps, knowledge sync state, owner-visible webhook failures, LLM reservations/usage and notification state. A single raw webhook envelope can contain multiple channels, so its signature/dedup record is installation-level infrastructure; tenant conversations/messages are scoped separately.

## Verification and remaining acceptance

100 offline unit/integration tests cover 51 generated Vietnamese golden **policy fixtures** (known classifier labels), multi-intent fact safety, source provenance, ambiguity, stale data, mandatory disclosure, import rollback/mapping/XLSX rejection, webhook signature/replay, concurrent budget reservation, encrypted prompts, Messenger-window checks, dry-run zero sends, human edits and email-only complaints. These fixtures are not recorded production responses and are not a live-model accuracy score. Dio's review/signoff and the >=95% real-model intent accuracy evaluation remain open.

The Playwright flow covers owner TOTP, real worker dry-run publishing, built-in knowledge creation, manual inquiry processing, facts review and approved dry-run reply. No live Meta, TikTok, SMTP, Google or LLM account call has been used as acceptance evidence. Real Sheets, webhook traffic, email delivery and a full day of dry-run traffic remain release prerequisites.

Team routing and token maintenance are documented in [Phase 3](PHASE_3.md). Reporting and analyst proposals follow. Coverage remains 24/7/365 with owner fallback.

Additional hardening covers English/mixed-language policy fixtures, blank/boolean monetary input, contradictory stock quantity/status, and future per-field timestamps. Products may provide stock quantity without status; zero maps to out, positive maps to in_stock. Explicit contradictory values are rejected. In-app approval notifications are visible in Inbox; complaints remain email-only.

For an explicitly authorized paid evaluation on the development checkout, configure your provider key and saved positive cap, then run `npx tsx src/server/eval/run.ts --live-evaluation`. It uses the same budget gateway, stops on provider/budget failure, and writes private `.local/live-evaluation.json` with exact intent-set accuracy, per-intent precision/recall and call IDs. Partial completion is reported explicitly. These generated examples still require Dio's signoff; no real-model evaluation has been run in this delivery.

Addressing is applied to `{addressing}` and `anh/chị` in voice-only text; emoji-off removes emojis from those style fragments. Source facts and approved FAQ wording remain verbatim. Samples remain human reference material rather than unbounded model-generated customer copy.
