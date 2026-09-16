# ADR-004: Persisted identity sessions and Helpa-owned authorization

Status: Accepted for implementation. Date: 2026-09-08. B2 resolved: Twilio.

## Context

Phone-only delegates, email magic links, optional passwords, required privileged-user TOTP, and immediate revocation are core product requirements. Platform OAuth credentials authorize the business account; they must not become delegate login credentials.

## Decision

Use Better Auth's identity/session and relevant authentication plugins backed by Postgres. Helpa owns the membership/role/channel and optional subtractive permission model. Open public registration is disabled after a one-time, server-controlled owner bootstrap. Invite acceptance binds the verified identity to the intended invitation; possession of an invite URL alone does not verify a phone/email.

Use opaque secure sessions and server-side membership checks on every request, plus a server-recorded MFA completion state. Disable authorization decisions from stale cookie caches. Require verified TOTP enrollment and a completed TOTP challenge for Owner/Manager; users who enabled TOTP also receive enforcement. Pending sessions may reach only enrollment/challenge/logout, never business resources. Privilege promotion forces enrollment/re-authentication before the new permissions are usable.

**Verified library caveat:** Better Auth's documented 2FA defaults challenge credential sign-in, while passwordless flows need custom enforcement. Passwordless enrollment also needs explicit configuration. Helpa must cover magic-link and SMS-verification callbacks, account recovery and newly issued sessions with server-side gates; frontend redirects are insufficient. [Official 2FA documentation](https://better-auth.com/docs/plugins/2fa).

The documented phone plugin offers custom verification integration for managed OTP and a temporary-email mapping for phone-only signup. If the pinned schema requires that field, use an opaque non-deliverable internal address, keep real email optional in the user profile, and never treat the placeholder as verified/contactable. Invite-only restrictions still apply. [Official phone plugin documentation](https://better-auth.com/docs/plugins/phone-number).

Define `SmsProvider` operations for beginning and verifying a challenge, plus an explicit optional notification capability. Implement the selected provider and a local console fixture; do not assume a managed Verify API sends arbitrary complaint alerts. Managed OTP handles code validation, while Helpa still atomically consumes its own challenge/invite grant to prevent concurrent membership redemption. Development codes must never appear in production logs. Email goes through an SMTP/provider boundary plus local capture.

Store sessions/device metadata and allow remote sign-out. Revoke memberships and sessions transactionally and check current authorization again in workers. Rate-limit by normalized recipient, IP and account with persistent counters; use generic responses to limit account enumeration. Tokens/links are expiring and single-use. TOTP recovery codes are encrypted by the authentication library and single-use; enrollment secrets are encrypted. Owner cannot be removed or demoted. Recovery is audited and must not provide a weaker remote bypass of privileged MFA.

## Authorization matrix

| Role    | Allowed                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Owner   | All business actions, platform connection/secrets operations and dangerous settings; secrets still never returned by an API |
| Manager | Post/reply approval, rules/knowledge, invite Agent/Editor/Viewer within own scope                                           |
| Editor  | Media and post draft/schedule; no approval bypass                                                                           |
| Agent   | Inbox reply/edit/approval/escalation, read-only posts                                                                       |
| Viewer  | Scoped read-only dashboard/log access; no mutations or credential material                                                  |

Channel scope narrows every role; optional permission allowlists only subtract capabilities. Approval-only staff are an Agent with `reply.approve` and the minimal supporting read access. Counts/search/export/download and direct resource fetches use the same checks as mutations. UI capability hints reflect the server, but are not enforcement.

## Alternatives and consequences

Custom authentication from scratch unnecessarily expands security-sensitive code. Managed auth can simplify operations, but creates a recurring dependency and requires careful support for these phone/TOTP/invitation flows. Stateless long-lived JWT authorization complicates immediate revocation.

Better Auth reduces identity plumbing, but plugin availability is not proof that the combination is safe. Pin a compatible version and prove each login path, concurrent redemption, role escalation, cross-channel denial and revocation before calling the phase complete. If the mandatory-MFA integration cannot be made correct in the selected version, revise this ADR rather than silently dropping TOTP.

## Phase 0 enforcement

Only password sign-in, sign-out, TOTP enrollment/challenge and recovery-code verification are exposed through an explicit route allowlist. The owner bootstrap uses a private setup token. Successful verification writes a server-side MFA-session row; privileged resource access checks it on every request. Magic-link/phone auth remain unavailable until their Phase 3 MFA hooks and tests exist. Recovery codes use the library-supported encrypted storage option; custom one-way hashing is not substituted into an API that requires code-list consumption.
