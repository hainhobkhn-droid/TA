# Reporting and Analyst delivery

Local implementation, 2026-09-08. Real platform history, approved business data and provider credentials remain external acceptance prerequisites.

## Reports

Reports offers today / 7 / 28 / 90 days and scoped channel selection. Operations use Helpa's persisted records: inquiries, manual inquiries, confirmed and simulated replies, automation/escalation rates, unanswered drafts, average first-response/resolution times with sample counts, per-human approval turnaround, intent/reason distributions, matched product SKU counts, hour-of-week volume and new/returning customers. Current and previous periods have matched duration; today begins at midnight in Vietnam. Dry-run messages never count as confirmed replies. Missing denominators/timing samples show unavailable, not zero.

In a conversation, staff can confirm an exact order ID belongs to the inquiry. The link records an immutable order version and cannot be counted twice. Reports show linked orders and revenue from those versions. The conversion rate uses distinct conversations with inbound messages in the selected period and an order link confirmed by period end, divided by all conversations with inbound messages in that period. Each conversation counts once; the denominator and definition are visible. Optional `orders.lines` is a JSON array of `{sku, quantity, line_total}`; line totals cannot exceed the order total. Product revenue is available only from these explicit lines. This is staff-confirmed association, not proof that the inquiry caused a sale. Records without explicit totals/lines do not produce invented revenue.

Set `AUDIENCE_METRICS_ENABLED=true`, reconnect channels and verify actual metrics scopes. The worker collects every six hours and retains immutable source snapshots; duplicate object/metric/day/period keys do not rewrite history.

- Meta requires `read_insights` and `pages_read_engagement`; video metrics additionally check `pages_manage_engagement`. Page metrics use current `page_media_view`, `page_total_media_view_unique` and `page_follows`. Available daily history is requested back to 93 days. Recent Helpa-published posts provide lifetime post views/unique viewers and reactions. Video/Reel endpoints provide supported view, complete-view and watch-time measures. Individual unavailable metrics remain missing. Current incomplete daily periods are excluded.
- TikTok requires the Display API `video.list` / `user.info.stats` scopes in addition to Content Posting. Profile follower/like/video counts and public-video views/likes/comments/shares are observed counters, not historical daily totals. Collection paginates up to 400 public videos per run. Watch time, reach and completion are unavailable through this Display API path and are not fabricated.
- Meta post collection is bounded to the latest 30 Helpa-published posts in 90 days. TikTok private or moderated videos may not appear in Display API. A source response can legitimately omit a metric.
- Daily unique viewers cannot be added across days. The UI uses the latest daily unique observation per period; additive daily view metrics use sums of available observations. Cumulative/gauge metrics use the last observation per period. Charts show source names, period and collection/end timestamps. TikTok history accrues after connection; no historical gains are invented. Reports return the latest 15,000 observations with an explicit truncation notice when necessary. More complete inventory/backfill needs an operator-reviewed extension to collection limits.

## Analyst

Detectors retain their period, channel, supporting counts/IDs and limitations. They identify top escalation reasons, stale-data incidents, repeat unanswered conversations, response slowdown (at least five confirmed samples per period), observed posting windows and post outliers. Posting-window advice requires at least ten observed posts and three in a two-hour window. Posting advice only uses posts published within its stated window. Lifetime counters are affected by post age; recommendations explicitly treat them as observational evidence, not causal experiments. Missing or too-small datasets produce no quota-filling advice.

An insight opens its relevant workflow. A posting-window suggestion pre-fills a new post's next-day Vietnam schedule while leaving content and approval to the user. Evidence IDs remain visible for review. Insights may be dismissed explicitly.

Owner or all-channel Manager can generate a FAQ/rule proposal from stored human draft/final edit pairs, or a narrative from stored insights. These calls share the configured LLM monthly cap. Proposals are persisted for editing/review; no model output changes runtime behavior by itself. Applying a FAQ, rule revision or narrative requires an explicit human action, validated content and an audit event. FAQ application and proposal status commit together; concurrent application cannot double-apply. Rule proposals based on an obsolete rule revision are rejected. Mandatory complaint handling remains enforced.

## Weekly digest

Each user opts into email and/or SMS. The worker prepares the digest Monday from 08:00 Vietnam time, using the completed week and prior week, up to five largest relative changes, and available evidence-linked recommendations. A reviewed narrative from the completed week is included only for users with all-channel access. Fewer than three supported recommendations are reported honestly; the system does not invent three to satisfy an acceptance quota.

Email uses SMTP. SMS uses Twilio Programmable Messaging with `TWILIO_MESSAGE_FROM`, separate from the Twilio Verify service used for authentication. SMS recipients need a verified phone number; email recipients need a real email address. Both global and notification modes must be live for sending. Email/SMS digest rows and their audit record commit atomically. Enqueued digests are idempotent, and preferences, revocation and channel scope are checked before delivery. A Twilio accepted response is recorded as provider-accepted, not handset-delivered. Ambiguous sends are held without automatic retry. Complaints never generate SMS.

## Validation and acceptance limits

Offline tests cover immutable/deduplicated snapshots, scope filtering, timezone boundaries, missing denominators, simulated-versus-confirmed replies, TikTok counters/string IDs, evidence sample thresholds, exact order attribution, concurrent human proposal application and digest opt-in/idempotency. The browser flow checks reports with empty audience history and the insufficient-evidence advice screen. Fixtures are generated/sanitized local data, not recordings from Dio's accounts.

The original live criteria remain open: 28-day real audience/operations history, representative live metrics, real email/SMS delivery and at least three actionable recommendations supported by real evidence. Full-scale collection limits, platform-specific fields not available through the granted APIs and the statistical effect of post age are explicit limits, not silently filled with estimates.
