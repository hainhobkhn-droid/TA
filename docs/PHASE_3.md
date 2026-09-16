# Key Cabinet delivery

Local implementation, 2026-09-08. Live Twilio delivery to a Vietnamese number and live token maintenance remain external acceptance checks.

## Team access

Team supports seven-day invitations by email or Vietnamese mobile number in `+84` format. The invitation fixes role, scope and any removed permissions. Its identity must be proven with a fresh single-use email link or SMS OTP before membership activates. No platform password is shared. Superseded, expired or revoked invitations cannot grant access. Managers can invite/edit Agent, Editor and Viewer within their own channel scope; Owner can also invite Managers. Owner cannot be demoted or revoked.

Email uses Better Auth magic links, hashed tokens and atomic consumption. Links open a confirmation screen using a URL fragment, which is removed from browser history before verification. Phone login uses the `SmsProvider` abstraction with Twilio Verify generation/checking, five checks per local challenge, ten-minute local expiry and database-serialized challenge consumption. Identity/IP rate limits persist in Postgres. All login methods re-enter Helpa's server-side TOTP gate; Owner/Manager must enroll and verify, including accounts with no password. Other roles can enroll from Security. An optional password can be set there after authentication.

`AUTH_DELIVERY_MODE=live` enables login SMTP and Twilio Verify independently of customer-facing `HELPA_MODE`. Configure SMTP, `MAIL_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and a `TWILIO_VERIFY_SERVICE_SID` from a Twilio Verify service. Enable the intended Vietnam geographic permissions and provider fraud controls. These credentials are server environment values. A saved invite remains pending if sending fails; recipients can request a fresh link/code from Sign in after configuration is fixed.

`AUTH_DELIVERY_MODE=console` works only in development/test and writes authentication messages to a private 0700 directory with 0600 files under `AUTH_DEV_OUTBOX`. It does not print codes into application logs or return them over HTTP. Production rejects console delivery. The default `disabled` mode makes no sends.

Removing permissions is subtractive: it never grants anything the role lacks. For reply-approval-only staff, choose Agent and remove `replies.write`; the inbox remains readable for approvals, while creating/manual inquiry writes are denied. For a Facebook editor/agent combination, choose Manager scoped to Facebook and remove unneeded permissions; this requires TOTP. Role/scope changes sign out that member's sessions. Revocation blocks their next API request and queued actions when the worker checks authority again.

## Coverage and audit

Duty slots are whole-hour intervals in Asia/Ho_Chi_Minh, Sunday=0 through Saturday=6. Overlaps on the same platform/day are rejected; overnight shifts use two slots. New escalations route to an eligible on-duty member, otherwise Owner. The inbox shows elapsed approval waiting time. Complaints create only an Owner email alert, plus the assigned conversation; a phone-only delegate's other email alerts also fall back to Owner. In-app approval notifications route to the delegate.

Security lists the current user's devices/sessions and supports immediate remote sign-out. Session tokens are never included in the list. Audit supports actor, action, channel and date filters plus CSV export (up to 10,000 matching events; narrow the interval for larger logs). CSV cells neutralize formula prefixes. Sensitive invitation, membership, session, duty and approval actions are audited.

## Tokens

The worker checks token health hourly. TikTok access tokens approaching expiry are refreshed using the stored refresh token; both returned tokens are encrypted and replaced together. Account identity and current connection state are checked before replacing credentials. An uncertain refresh requires reconnection. Facebook Page tokens are inspected with `debug_token`; Meta does not provide a generic Page refresh-token flow, so invalid/expired tokens require reconnect. Tokens with no scheduled expiry are still checked. Seven-day expiry warnings use email and in-app notifications.

TikTok upload status is reconciled through the read-only status API. Upload acceptance/inbox transfer remains a task to finish in TikTok. A confirmed `PUBLISH_COMPLETE` is marked published; if TikTok provides no usable public permalink, Helpa says so and does not invent one. No upload is restarted by the status poller.

Encryption-key rotation now re-encrypts LLM request/response envelopes as well as channel credentials. Stop app/worker before rotation and keep historical keys with encrypted backups.

## Verification

108 offline tests include concurrent phone OTP redemption, Facebook-only scope enforcement, privileged passwordless TOTP enrollment, invite authority, session revocation, approval-only permissions, on-duty boundaries, owner protection, CSV formula protection and TikTok credential rotation with a fixture transport. Browser acceptance extends the owner workflow with an invited phone delegate using the private console fixture, Facebook inbox access and revocation. Provider delivery, real account refresh and operational coverage still need live validation; test fixtures are not live evidence.
