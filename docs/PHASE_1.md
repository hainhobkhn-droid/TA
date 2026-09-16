# Publisher delivery

Local publishing workflow: Media → upload → thumbnail/metadata → optional 9:16 rendition → Calendar & posts → channel variants → scheduled Vietnam time → Manager/Owner approval → worker → exact payload in System. List/week/month views, drag reschedule (invalidates approval), duplicate, and bounded weekly recurrence expansion are available. Every recurrence is a separate revision requiring approval. Recurrence currently expands 1–12 weeks explicitly; it does not perpetually generate unattended approvals.

The worker checks revision, scheduler membership, approval membership, current channel mode/connection and pause before publishing. Dry-run records a terminal `would_have_sent` and no synthetic platform ID. Moving a channel to live cannot replay it: duplicate and approve a new variant. A 5-second database scan recovers scheduled work after restart; busy workers/outages may make it late, never early.

Facebook transports cover text, single/multiple photos, resumable-upload-session video, Reel upload/finalization and first comment. Each mutation has a durable, audited step. Successful steps are reused. Unknown outcomes stop with `needs_action`; they are never blindly retried. A first-comment error cannot republish a successful parent. Resume is only allowed when all recorded steps have confirmed success (for example, a Reel waiting for processing). Interrupted transfer reconciliation and all live format acceptance still require account testing; do not delete a started step to force retry. Download/copy the revision for manual completion, then record its actual permalink.

TikTok Web OAuth stores access/refresh tokens encrypted. Direct Post and inbox initialization use server-hosted `PULL_FROM_URL`, a short-lived signed URL, explicit consent and a verified owned domain. Direct Post checks current creator privacy/interactions/duration and `TIKTOK_DIRECT_POST_ELIGIBILITY=approved`; the default is unverified. The UI offers a manual export. An accepted upload stays `needs_action`, not published. TikTok status reconciliation/refresh now run in the worker; see PHASE_3.md. All transports use ChannelAdapter.

## Evidence

- Unit/integration tests cover 18:00 Asia/Ho_Chi_Minh → 11:00 UTC, not-before-due dispatch, approval invalidation, revoked approver, exact media hashes, no dry-run transport calls, no duplicate completed operations, audit failure stopping sends, ambiguous-outcome suppression, recurring expansion and synthetic Facebook text/comment contracts.
- Playwright drives actual media upload/ffprobe/thumbnail, Reel creation, approval, worker dry-run dispatch and payload review. Both desktop and phone layouts are exercised alongside foundation login/MFA checks.
- These are local fixtures. Real Facebook/TikTok publication, account policies, app eligibility, public HTTPS transfer URLs, owner-provided media and production behavior remain unverified.

## Current implementation limits

- Local private volume only; S3-compatible storage is a future optional backend.
- Upload cap defaults to 100 MB and video duration to 600 seconds to fit the VPS. These are local resource limits, not platform limits. ffmpeg is bounded to one rendition job at a time, one encoding thread and a ten-minute process timeout; originals remain unchanged.
- Reels use the officially documented conservative 9:16 / 540×960 minimum / 3–90 sec / 24–60 FPS profile. The new rendition adds padding, not cropping, and never silently trims a video.
- No automatic rewriting or claim generation in the composer. Human copy remains verbatim for approval.
- Best-time hints are generated from sufficient observed metrics; see PHASE_4_5.md. Empty data produces no recommended time.

Reels remain pending after finalization until Meta reports the publishing phase completed with published status. Use Resume/check processing to reconcile known steps; unknown mutations still require operator review.
