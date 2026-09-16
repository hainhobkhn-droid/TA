# ADR-002: Postgres queue with explicit delivery state

Status: Accepted for implementation. Date: 2026-09-08.

## Context

Scheduling must survive restarts, preserve approvals, honor Vietnam wall-clock times, and avoid duplicate outbound effects. A queue's internal delivery guarantees cannot establish exactly-once effects across a database and a remote API without a shared transaction or provider-supported idempotency.

## Decision

Use pg-boss in the existing Postgres database. Its documented support for inserting jobs in an existing database transaction fits atomic domain-state/job writes. Validate the selected Drizzle/pg-boss transaction integration in Phase 0; if unavailable in the pinned version, use a transactional outbox rather than independent commits. [Official repository](https://github.com/timgit/pg-boss).

Treat processing as replayable. Every logical external effect has a unique key incorporating business, channel, variant/draft revision, and effect type. Database uniqueness, state transitions and locks serialize dispatch. Prefer documented provider idempotency when available; do not invent an idempotency request header or infer it from queue support.

Persist effect intent before transmission and attempt outcome afterward. If a process dies or a request times out after transmission, reconcile from known remote IDs/status APIs. If the result cannot be established, mark `needs_action` and stop automatic retransmission. The product favors delayed/manual resolution over a possible duplicate in this case.

Use exponential backoff with jitter and a bounded attempt count (initial proposal: five attempts, 30-second base, 30-minute cap). Retry only confirmed safe transient failures and honor documented rate-limit delays. Authentication, validation, capability and policy failures become actionable states. Persist upload session IDs/offsets and first-comment progress separately. Expired leases do not by themselves justify re-sending a remote operation.

Schedules are UTC instants. Recurrence stores business timezone/local wall clock and materializes bounded future occurrences with unique keys. A recurrence/template change invalidates affected approvals. Schedule edits increment revision; stale jobs wake and no-op. Use a timezone library with IANA data; test Vietnam conversion and Los Angeles DST display/ambiguous input.

## Alternatives and consequences

BullMQ/Redis provides mature queue features but adds a second datastore and backup/failure boundary. Graphile Worker is a credible Postgres alternative; pg-boss better fits the chosen TypeScript integration direction without a separate SQL-task convention.

Keeping jobs with application data simplifies consistency and restores, but requires queue-table maintenance, connection limits and monitoring. Separate queues/priorities and bounded worker concurrency prevent transcodes from starving replies. Keep long-lived audit history outside queue retention.

## Required proof

Test atomic enqueue rollback, crash/restart, duplicate delivery, rescheduling, concurrent approvals, revoked memberships, unknown remote outcomes, and first-comment retry without parent republish. Restore workers paused: remote posts made after the backup may exist even when their local success rows do not.
