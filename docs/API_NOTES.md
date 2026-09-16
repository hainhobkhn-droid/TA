# Official API verification register

Reviewed: 2026-09-08. This preliminary register supports planning. It is **not** permission to implement endpoints that have not been verified. Every adapter operation needs a pinned API version, current scope/permission, official request/response reference, limits, retry/error semantics, and sanitized fixtures before implementation. No requests to Dio's accounts have been made.

## TikTok Content Posting

The [current sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) exclude internal/private utilities for accounts the developer or their team manages. **Inference:** Helpa's single-business scope is a Direct Post eligibility risk, not just an audit delay. Ask TikTok about eligibility before promising public Direct Post. The same guidelines restrict unaudited Direct Post to private visibility; active app/account limitations also apply.

If eligible, implement explicit user preview/consent, current creator settings and permitted privacy choices, disclosure controls, and publication-status tracking. Re-read the full required UX and upload-source rules during Phase 1. Never hard-code permission to publish from a generic “TikTok connected” status. Manual export remains available. Inbox upload requires its own granted scope and is not an assumed policy loophole.

Additional verified pages:

| Source                                                                                                         | Verified planning fact                                                  | Still required before coding                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Direct Post getting started](https://developers.tiktok.com/docs/en/content-posting-api-get-started)           | Direct Post needs approved `video.publish` scope and user authorization | Selected account/app eligibility, OAuth configuration, current request sequence              |
| [Direct Post reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)       | Official API reference is accessible                                    | Extract and fixture-test exact fields, status handling and limits                            |
| [Upload getting started](https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content) | Official inbox-upload documentation is accessible                       | Verify `video.upload`, account grant, user completion flow and upload limits before enabling |

Full capability matrix will distinguish Direct Post eligibility, audit state, user grant, inbox upload, manual publish, inbox ingest/reply, comments and metrics. Different operations can have different modes on one channel. No fixed audit turnaround is promised.

## Meta — Phase 0 verification completed by direct official-page retrieval

On 2026-09-08, the web research tool still returned retrieval errors, but direct HTTPS retrieval of the official pages succeeded. Phase 0 uses Graph API v25.0 as shown by the retrieved guides, with configurable version pinning; this is not a claim that v25.0 is the newest version supported by every app.

| Official reference                                                                                            | Verified and implemented                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Manual OAuth flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/)         | Versioned dialog/oauth with code/state/redirect/scope; server-side oauth/access_token exchange; debug_token inspection of app, validity, scopes and expiry |
| [Long-lived tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/) | fb_exchange_token exchange; Page accounts discovery using the long-lived user token; Page tokens can have no fixed expiry but remain revocable             |
| [Pages getting started](https://developers.facebook.com/docs/pages-api/getting-started/)                      | pages_show_list and me/accounts; Page ID/name/access token/tasks response                                                                                  |
| [Secure requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests/)                     | Server-side HMAC-SHA256 appsecret_proof binding                                                                                                            |

Phase 0 requests **pages_show_list only**. Publishing/reply permissions do not become enabled capabilities merely because token inspection lists them. One retrieved getting-started page uses the inconsistent spelling pages_manage_read_engagement; that spelling is not requested. Verify each later permission against the dedicated reference before implementing that operation. Temporary and persisted Page tokens never leave the server.

Still requiring detailed verification before their owning phases: [Reels publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing), [Page webhooks](https://developers.facebook.com/docs/graph-api/webhooks/reference/page), [Messenger overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview), [Send API](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages), [Messenger policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy), and [permission reference](https://developers.facebook.com/docs/permissions). No policy exception or message tag is implemented by guesswork.

## TikTok business messaging/comments

[Direct messages](https://business-api.tiktok.com/portal/docs/direct-messages/v1.3) and [reply to comment](https://business-api.tiktok.com/portal/docs/reply-to-a-comment/v1.3) returned empty page bodies through the research tool. Endpoint, permission, signature, policy and eligibility details remain unverified. Do not implement guessed HTTP routes. Use manual threads until the official docs and account access are available.

## Auth and queue references

- [Better Auth 2FA](https://better-auth.com/docs/plugins/2fa): passwordless enforcement caveat incorporated into ADR-004; test the actual pinned library combination.
- [Better Auth phone number](https://better-auth.com/docs/plugins/phone-number): provider verification hooks and phone-only identity adaptation are documented.
- [pg-boss](https://github.com/timgit/pg-boss): Postgres-backed jobs and transactional insertion support; external publication still needs reconciliation.

## Other implementation gates

The selected LLM's schema features/rates, Google Sheets read-only scopes/limits, SMS sender/delivery rules, storage/media libraries, and metric availability will be checked against their official documentation in the owning slice. The brief's food-advertising decree/fine figures are not independently verified here and will not be repeated as legal conclusions. The requested prohibition on unsupported health, quality and origin claims is a product constraint regardless of those figures.

## OpenAI configuration

[Official API quickstart](https://developers.openai.com/api/docs/quickstart) was fetched on 2026-09-08. OpenAI integration uses a server-side API key. Phase 0 exposes provider/model/cap settings only; structured output, model availability, rates and request execution will be verified before Phase 2. No ChatGPT session automation is used.

## Publisher verification — 2026-09-08

Official Meta pages were fetched directly with curl because the web retrieval proxy returned 429. Versioned request examples are pinned to configurable v25.0; reference pages may display v26.0. Sources: [Posts](https://developers.facebook.com/docs/pages-api/posts/), [Page Photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/), [Video publishing](https://developers.facebook.com/docs/video-api/guides/publishing/), [Reels](https://developers.facebook.com/docs/video-api/guides/reels-publishing/), [Object comments](https://developers.facebook.com/docs/graph-api/reference/object/comments/). The general Posts guide and dedicated Video guide differ on `publish_video`; Helpa requests the dedicated guide's `pages_manage_posts` / `pages_read_engagement` plus `pages_show_list`, and `pages_manage_engagement` for comments. Actual capabilities must be verified on Dio's app; a failed permission becomes a reconnect/manual task. The user token needed for resumable upload sessions is encrypted alongside the Page token and is excluded from selection/browser responses.

TikTok: [Web Login](https://developers.tiktok.com/docs/en/login-kit-web), [token management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management), [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post), [inbox upload](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video), [creator info](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info), [media transfer](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide), [post status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status). Scope grant and content-sharing eligibility are distinct. Internal account-management utilities may be ineligible for Direct Post; an env flag is an operator attestation after provider confirmation, not evidence supplied by Helpa. Upload success is not publication.

## Front Desk sources (checked 2026-09-08)

- [Meta Messenger send messages](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages): Page `/messages`, PSID recipient, `messaging_type=RESPONSE`, standard 24-hour window and automation disclosure.
- [Meta webhook setup](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/): verify challenge and raw-body HMAC-SHA256 signature.
- [Meta Page webhook fields](https://developers.facebook.com/docs/graph-api/webhooks/reference/page/): feed comment and message normalization.
- [Meta comments](https://developers.facebook.com/docs/graph-api/reference/object/comments/): comment reply endpoint and engagement scope.
- [Google Sheets values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get) and [service-account authorization](https://developers.google.com/identity/protocols/oauth2/service-account): read-only shared Sheet access through GoogleAuth.
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini): Responses JSON schema, model capabilities and rates.
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing): `output_config.format`, supported models and Haiku 4.5 rates.

## Team access and maintenance (checked 2026-09-08)

- [Better Auth magic links](https://better-auth.com/docs/plugins/magic-link), [phone numbers](https://better-auth.com/docs/plugins/phone-number), and installed 1.7.3 implementation: hashed single-use links, managed `verifyOTP`, passwordless two-factor enrollment.
- [Twilio Verify start](https://www.twilio.com/docs/verify/api/verification), [check](https://www.twilio.com/docs/verify/api/verification-check), and [service rate limits](https://www.twilio.com/docs/verify/api/service-rate-limits): fixed Verify endpoints, SMS channel, `approved` plus `valid` result.
- [TikTok token management](https://developers.tiktok.com/doc/oauth-user-access-token-management) and [post status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status): rotated refresh credentials and publication-state reconciliation.

## Audience reporting (checked 2026-09-08)

- [Meta Insights reference](https://developers.facebook.com/docs/graph-api/reference/insights/): Page/Post metric names, periods, `read_insights`, Page ANALYZE task and deprecated unique-impression metrics. The reference currently displays v26 examples; Helpa retains its configurable v25 pin and records missing fields explicitly.
- [Meta Video Insights](https://developers.facebook.com/docs/graph-api/reference/video/video_insights/) and [guide](https://developers.facebook.com/docs/video-api/guides/insights/): video/Reel lifetime view and watch-time metrics, milliseconds and endpoint shape.
- [TikTok List Videos](https://developers.tiktok.com/doc/tiktok-api-v2-video-list), [Video Object](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object) and [User Info](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info): public-video pagination, string IDs, observed counters and relevant Display API scopes.
- [Twilio Messages](https://www.twilio.com/docs/messaging/api/message-resource): opt-in digest SMS uses Programmable Messaging; API acceptance does not establish handset delivery.
- [Claude schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs): unsupported numeric/string/array constraints are conveyed as descriptions in the wire schema and enforced against the original Zod schema after the call.
