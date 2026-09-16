# Decisions and remaining inputs

Updated: 2026-09-08. Dio answered B1–B3 and Q4–Q7; application work is authorized. Credentials are installed through local environment configuration, never committed or pasted into chat.

## Confirmed decisions

| ID  | Dio's answer                                                  | Implementation consequence                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | OpenAI or Claude, API-key based; configurable monthly cap     | Selectable `openai` / `anthropic`, configurable model and USD cap. Anthropic remains the initial selection; cap defaults to 0 (paid requests disabled) until configured. OpenAI uses the API, not a ChatGPT browser session. Provider execution belongs to Phase 2. |
| B2  | Twilio                                                        | Twilio Verify for phone OTP in Phase 3; console provider for local tests.                                                                                                                                                                                           |
| B3  | Existing VPS/domain; document setup                           | Provide a host-independent VPS setup guide with hostname/environment placeholders. Do not provision or deploy to the VPS without its actual connection details.                                                                                                     |
| Q4  | Meta and TikTok apps created; access granted                  | Treat access as owner-reported; inspect actual scopes/capabilities during connection. Credentials/IDs and exact grants remain runtime inputs, not blockers to local development.                                                                                    |
| Q5  | Data and voice samples will arrive in separate Markdown files | Reserve a documented input location. No real product facts or voice examples assumed.                                                                                                                                                                               |
| Q6  | 24/7/365 coverage                                             | Always-open coverage; owner fallback until a delegate on-duty rota is supplied.                                                                                                                                                                                     |
| Q7  | Complaints trigger email only                                 | Human-only handling and visible inbox assignment; email is the only active complaint notification transport. No SMS or push/in-app notification alert for complaints.                                                                                               |

## Remaining runtime inputs

Actual VPS hostname and environment secrets; Meta app ID/secret and approved OAuth configuration; provider API key/model and positive cap if enabled; SMTP server/sender/complaint recipient; product and voice Markdown files. These do not block Phase 0 code. Real-account acceptance and VPS deployment remain unverified until configured and exercised.

## Recorded defaults

- UI language Vietnamese, selectable English; reply language detected per incoming message. Warm anh/chị addressing. Brand-voice seed is provisional until Q5.
- Business timezone Asia/Ho_Chi_Minh. User display timezone is independent; owner may choose America/Los_Angeles. Currency VND; money stored as decimal, never binary float.
- `HELPA_MODE=dry_run`. An additional owner-controlled automation pause also suppresses automatic holding replies. Global dry-run cannot be overridden by a channel.
- Posts require approval by default; Owner/Manager can approve. Editing approved content invalidates the approval.
- Freshness limits: prices 24 hours, stock 2 hours, shipping 7 days, FAQ 30 days. Missing trustworthy fact timestamp means not fresh.
- Duplicate-reply suppression: 10 minutes. Initial classification threshold: 0.90, uncalibrated; tune against Dio's signed-off golden set, never use confidence to bypass a fact/policy failure.
- Approval SLA target: 15 minutes; owner fallback if nobody is on duty. The holding copy will avoid promising a response deadline until staffing is confirmed.
- Local disk media with optional S3-compatible storage later; one simultaneous transcode on the target VPS. No Redis.
- Audit retention minimum 12 months; backup target RPO 24 hours / RTO 4 hours, to be validated by a restore drill.
- Unknown platform capabilities default to manual/disabled. TikTok eligibility risk is documented in [API notes](API_NOTES.md), and is not presumed resolved by waiting for an audit.

## Reconciling requirements

The delegation story includes an “approve drafts only” staffer, but none of the five named roles is restricted to that action. Proposed refinement: keep the five roles and allow an optional per-membership permission allowlist that can only subtract permissions. An Agent restricted to `reply.approve` can inspect the supporting thread/facts without freeform send, editing, or assignment. Owner retains full authority. This is a recorded implementation assumption, not an additional blocker.
