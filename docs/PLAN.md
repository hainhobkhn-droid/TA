# Helpa delivery plan

Status: Phases 0–5 have locally verified implementation slices; real-account acceptance remains open, 2026-09-08. Dio resolved [B1–B3](OPEN_QUESTIONS.md): OpenAI/Claude API-key configuration, Twilio, existing VPS/domain with a setup guide. Runtime credentials and real-account tests remain separate prerequisites.

## Delivery rules

- Ship each phase as a runnable UI-to-worker/database slice, with a walkthrough, appropriate automated checks, updated README/runbook/environment reference, and a clear commit.
- Distinguish locally verified behavior, provider sandbox verification, and real-account acceptance. A passing fixture is never evidence of a live integration.
- Read the official API documentation before each adapter operation is implemented; record verification date, API version, scopes, request/response fixture, limitations, and human fallback. Inaccessible documentation is an explicit operation-level blocker.
- Deploy dry-run first. Outbound audit persistence, policy enforcement, role/channel authorization, and approval integrity are prerequisites to every send path, starting with Phase 0 foundations and fully applied in Phase 1.
- Do not claim completion of a phase's live acceptance while app access, data, or credentials are missing. Complete independent work and record exactly what remains externally blocked.

## Planning slice — completed prerequisite

- [x] Read the full brief and inspect the empty workspace.
- [x] Write phased plan, component/data architecture, and ADRs for stack, queue, LLM gateway, and auth.
- [x] Record questions, defaults, official-doc findings, and third-party eligibility risks.
- [x] Dio answered B1–B3; decisions updated before Phase 0.
- [x] Phase 0 begins. Application code follows the accepted decisions.

## Phase 0 — Foundation

Local implementation and checks are complete; [delivery evidence and remaining real-account acceptance](PHASE_0.md).

**Clickable result:** bootstrap owner → enroll/verify TOTP → log in → open Channels → connect Facebook Page → inspect token metadata, audit entry, and System page.

Scope:

- TypeScript app + worker + Postgres + Caddy in Compose; health/readiness checks; versioned migrations and a reproducible build. Local HTTPS uses a local CA with documented trust installation; real webhooks require public HTTPS/DNS.
- One-time owner bootstrap, then closed registration. Secure persisted sessions, required Owner/Manager TOTP, server-side role/channel skeleton, membership revocation checks.
- Vietnamese/English UI scaffolding, personal display timezone, business settings, global mode and automation pause, audit writer and basic audit screen.
- Facebook OAuth state binding, verified permissions, Page selection, encrypted credential storage, safe token metadata DTOs, revoked/unknown-expiry states. No assumed perpetual Page-token lifetime.
- System UI: app/worker/DB status, queue counts, empty webhook/sync panels, mode, token health. `/healthz`, readiness, structured secret-redacted logs.
- Document env variables as they are introduced, owner recovery, backup/restore design, Meta review steps and TikTok eligibility/application preparation.

Acceptance:

1. Fresh Compose deployment supports owner login/TOTP and persistent data across restart; pre-TOTP sessions cannot access business APIs.
2. Real OAuth connects Dio's Page and displays its actual name and known expiry or explicit “unknown/not provided”; no token appears in browser responses/logs.
3. Unauthorized/cross-channel operations fail server-side; audit entries record connection and settings changes.
4. Dry-run outbound boundary is tested even before publish features exist. OAuth/token exchange and read-only account calls are classified separately from customer-facing writes.
5. Offline tests cover sessions, authorization, encryption roundtrip/tamper failure, mode precedence, and audit failure preventing send.

External dependencies: B1–B3, public callback URL, Meta app/Page access. Missing Meta access permits a local demo but keeps acceptance item 2 open.

## Phase 1 — Publisher

First local slice delivered; [evidence and remaining limits](PHASE_1.md).

**Clickable result:** upload media → inspect validation/renditions → create channel variants → approve → schedule in Vietnam time → inspect exact dry-run payload/status → retry or complete a manual task.

Scope:

- Local volume media uploads; ffprobe metadata, thumbnails, bounded ffmpeg jobs; per-capability size/duration/codec/aspect checks from current docs. Optional S3 storage interface. Show rejection reasons before schedule.
- Posts/variants, captions/hashtags, Facebook first-comment, text/photo/multi-photo/video/Reels as supported per channel. Unsupported combinations become explicit manual tasks, never implicit format conversions.
- Calendar month/week/list, drag reschedule, duplicate, per-variant time, recurring templates expanded in business timezone. Evidence-based best-time hints activate when enough metrics exist.
- Persistent jobs; atomic scheduling; immutable approved revisions; idempotency and resumable publication substeps; bounded exponential retry; reconciliation after ambiguous timeouts.
- Facebook formats only after official API verification. TikTok Direct Post capability path, gated by actual eligibility/authorization; inbox-upload capability where granted; manual export otherwise. Persistent mode/eligibility banner and explicit creator consent fields.
- Post approval toggle; Manager/Owner approvals; payload preview; exact outbound attempt audit and plain-language errors. Apply forbidden-claim checks to any generated post copy; do not silently rewrite human copy.

Acceptance:

1. E2E schedules a Reel for **2026-09-09 18:00 Asia/Ho_Chi_Minh = 2026-09-09 11:00Z**. Worker must not send before due; controlled-clock test captures the exact adapter payload at dispatch. Target healthy-worker lateness under 30 seconds; outages show overdue/recovery status.
2. System shows “would have sent,” UTC instant, business/user timezone, revision, media hashes, and exact semantic payload. Dry-run performs zero platform content/reply/upload mutations and does not invent a platform ID/permalink.
3. Restart/replay does not duplicate a known completed operation. Unknown external outcomes become `needs_action` pending reconciliation. First-comment failure never republishes the parent post.
4. Unapproved/edited/revoked-authority variants cannot publish. Switching to live does not replay dry-run successes; a new approved dispatch is required.
5. Live authorized Facebook publication stores confirmed ID/permalink. TikTok upload completion is not public publication; UI tracks `needs_action` until completion is verified.

External dependencies: verified publishing specs, platform access, sample media. Direct Post public acceptance may remain unavailable for this internal-use product; manual acceptance does not silently replace the original live criterion.

## Phase 2 — Front Desk

Local slice delivered; [setup, verification and external acceptance](PHASE_2.md).

**Clickable result:** map/import knowledge → sync → paste a manual inquiry or ingest a webhook → view intent/entities/facts → inspect dry-run reply or approve a draft with escalation reason.

Scope:

- Signature-verified Messenger/Page-comment ingestion; durable fast acknowledgement, duplicate/replay handling, async normalization. TikTok messages/comments only if granted and documented; manual threads always work.
- Built-in product/shipping/FAQ/policy/order tables; Excel upload/re-upload; read-only Sheets API service account or published-CSV import. Column mapping preview, schema diff, sync logs, 10-minute polling and sync-now. Source timestamp semantics are explicit.
- Discrete classify/extract/rules/match/freshness/compose/fact-check/policy/act/learn steps with versioned YAML, strict schemas, budgeted provider gateway and offline fixtures.
- Diacritic-aware matching with explicit ambiguity, multi-intent handling, per-message language, approved brand voice, source-version facts panel. Conservative fallback on any missing required fact.
- Approval inbox filters, ownership, holding replies subject to the same pause/window/dedup rules, in-app notification and configured email. Store human draft/final edit pairs.
- Messenger policy/window enforcement at send time, including held approvals. No generic message tag or human-agent escape hatch for automation.

Acceptance:

1. The tôm sú size-20 / Đà Nẵng example runs against Dio's real sheet in dry-run, with every customer-facing fact linked to immutable record version, source row, field, and freshness timestamp.
2. Stale/missing/ambiguous facts never enter the customer reply, including partial multi-intent failures; the human sees last-known values and the reason. Re-syncing unchanged old values does not make them fresh.
3. Exact prices, stock, location, units, negation, and delivery bounds survive composition. Attempts to add health/origin/quality claims or obey injected instructions fail the gate.
4. At least 50 labeled Vietnamese-style inquiries plus English/mixed-language cases run offline. Report per-intent and multi-intent exact-set accuracy; Dio signs off the set; target at least 95% exact intent-set accuracy and 100% safety-case outcomes. Do not equate mocked gateway coverage with real-model accuracy; separately evaluate the selected real model within the approved budget.
5. Tests cover all default intents, source mappings, schema rollback, matching, freshness, forbidden claims, confidence, duplicate/window rules, human edits, and paused holding replies. Adapter contract tests use sanitized recorded fixtures.

External dependencies: approved real data/voice examples, LLM key/cap, webhook permissions/public domain, optional Sheets service account.

## Phase 3 — Key Cabinet

Local slice delivered; [setup and verification](PHASE_3.md).

**Clickable result:** invite a phone-only delegate → accept SMS OTP → work only Facebook inbox → inspect action audit → revoke and see the session lose access.

Scope:

- Email magic-link invite with optional password; chosen managed SMS verification plus console provider; expiring, single-use invitations with fixed role/channel scope. TOTP available to all and enforced for Owner/Manager across every login method.
- Roles plus subtractive permissions for approval-only staff; server-side scope on search, counts, attachments, exports, and mutations. Managers invite only Agent/Editor/Viewer within their own scope.
- Team/on-duty editor in Vietnam time, fallback owner, approval routing, SLA timers, per-user notification preferences and remote device/session sign-out.
- Audit filtering and CSV export; token refresh where supported, reconnect otherwise, seven-day expiry warnings, safe key rotation and immediate disconnect behavior.

Acceptance:

1. Dio's phone delegate can work Facebook inbox and cannot access TikTok through direct requests or guessed IDs; UI and server agree.
2. Every sensitive action is audited; revoking membership invalidates access on the next server check and blocks queued actions not yet dispatched. Already-sent network requests cannot be recalled.
3. Concurrent invite/OTP redemption cannot grant duplicate membership or reuse challenges; rate limits apply across app/worker processes; recovery cannot bypass privileged TOTP.
4. SMS delivery is verified on a real Vietnamese number. Token expiry/refresh/revocation failure paths are visible and tested. Owner cannot be removed/demoted.

## Phase 4 — Dashboard

Local reporting delivered; [coverage and limits](PHASE_4_5.md).

**Clickable result:** select 28 days/channel → compare audience and operations trends → inspect evidence and best-time hints → opt into weekly digest.

Scope: capability-aware daily immutable metric snapshots, supported Facebook/TikTok audience measures; operations response/resolution/approval metrics and automation/escalation rates; interaction hour-of-week and returning customers; 1/7/28/90-day ranges and previous-period comparisons; optional exact order-link conversion/revenue; opt-in digest with five largest changes. No fabricated metrics for unsupported permissions.

Acceptance: real 28-day data with source/fetch times and comparison, or clearly incomplete history until 28 days accrue; correct handling of missing data and zero denominators; mobile UI; idempotent digest delivery; reproducible aggregates and timezone boundaries. External dependency: granted metrics capabilities and elapsed history; no invented backfill.

## Phase 5 — Analyst

Local detectors and human-reviewed proposals delivered; [coverage and limits](PHASE_4_5.md).

**Clickable result:** read weekly insights → open underlying counts/posts → review a prefilled scheduling/FAQ/rule change → explicitly apply it.

Scope: deterministic detectors for posting windows, staffing/response degradation, unresolved repeat contacts, knowledge gaps, stale incidents and post outliers; versioned evidence; LLM narrative and proposed FAQ/rules from edit pairs; minimum sample-size handling. Human review required for every behavior change.

Acceptance: at least three actionable, evidence-linked recommendations in a real-data weekly digest when supported by sufficient evidence; claims reproduce from stored snapshots; too-small datasets say insufficient evidence; applying creates a new approved revision and audit event. No automatic rule learning or fabricated recommendations to fill a quota.

## Release proof and operations

- All three must-have stories tested live on Dio's accounts; retain any unsatisfied platform gate as an explicit release limitation.
- Process one full day of real inbound traffic in dry-run with outbound transport instrumentation demonstrating **zero customer-facing platform writes**. Account reads/token maintenance are reported separately; if a literal zero-platform-egress exercise is wanted, disconnect those and use already-stored inputs.
- Offline CI: lint/typecheck, targeted units, Postgres integration, recorded adapter contracts, golden set, Playwright dry-run scheduling flow. No real secrets/network APIs in offline tests.
- Run backup/restore in isolation before production, confirm media references and required encryption keys, resume restored jobs only after external-outcome reconciliation. Demonstrate incident pause, token rotation, and new-adapter procedure.
- Capture each phase's commands, results, demo instructions, and unresolved external prerequisites in its delivery note; commit only the verified slice. Elapsed app review/audit time is not an engineering estimate.

Current verification: [VALIDATION.md](VALIDATION.md), including automated checks, Docker/HTTPS, backup/restore and remaining real-account acceptance.
