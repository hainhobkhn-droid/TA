# ADR-001: TypeScript modular monolith

Status: Accepted for implementation. Date: 2026-09-08. B3 resolved: existing VPS/domain; setup documentation requested.

## Context

One small business, a few delegates, thousands of monthly messages, and a 2-vCPU/4-GB host need reliable operations and a usable phone UI. There is no need for distributed services. Both supported stack families can meet the brief; the question is how much operational and interface complexity to accept.

## Decision

Use React/Vite for a responsive browser UI, served with a Fastify JSON API from one Node.js web process. Run a second Node.js process for workers. Use TypeScript and shared Zod schemas across both. Store domain data in Postgres with reviewed SQL migrations and native pg access for the foundation; use pg-boss for jobs. Deploy through Docker Compose behind Caddy, with local media volumes and optional S3-compatible storage.

Organize by auth, channels, scheduler, inbox, rules, knowledge, llm, metrics, advisor and audit. Provider packages may only appear in their integration modules. Use direct ffmpeg/ffprobe processes rather than an unverified wrapper. Proposed supporting libraries: ExcelJS for XLSX, i18next, Vitest and Playwright; verify maintenance, licensing and exact versions before installing. Spreadsheet formats, resource limits and import correctness remain acceptance tests regardless of parser choice.

## Alternatives

- Python/FastAPI plus React offers strong data tooling, but adds two runtimes, duplicated schema concerns and a second dependency ecosystem without a demonstrated requirement here.
- A Next.js full-stack application reduces some initial wiring, but Helpa is mostly authenticated operational UI; static React assets plus explicit API/worker boundaries make deployment and auth behavior easier to inspect. No SSR requirement drives this project.
- Managed backend/auth/queue services can be introduced behind boundaries later, but are not required to keep this small installation available.

## Consequences

One language, one database and one deployment host keep cost/operations understandable. We own patching, migration discipline and backups. CPU-heavy transcodes need bounded concurrency and measured resource limits. Vite is a build tool, not the production server. Version numbers will be pinned after compatibility verification rather than guessed in the planning slice.

Phase 0 must prove a fresh-host build/deploy/login/worker cycle; Phase 1 must measure resource behavior during a transcode and scheduled send. No VPS vendor or plan is purchased by this decision.

## Phase 0 implementation note

Use native pg queries in the small foundation instead of introducing an unused ORM. This makes shared transactions, advisory locks, Better Auth schema integration and pg-boss insertion explicit. TypeScript/Zod guard application boundaries; consider Drizzle for growing feature repositories in a later ADR update. Pinned versions are recorded in package-lock.json.
