# Architecture decision records

All records are **accepted for implementation**, dated 2026-09-08. Dio resolved the blocking decisions; provider secrets and live acceptance are separate runtime prerequisites.

| ADR                       | Decision                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------- |
| [001](001-stack.md)       | TypeScript modular monolith on a paid single VPS                                   |
| [002](002-queue.md)       | pg-boss/Postgres queue and explicit external-delivery reconciliation               |
| [003](003-llm-gateway.md) | Provider-neutral gateway with a budget ledger and constrained factual output       |
| [004](004-auth.md)        | Better Auth primitives, persisted sessions, Helpa authorization and mandatory TOTP |

Later changes supersede a record or append a dated rationale; do not erase the original trade-off. Scope-specific decisions can be added as future slices make them concrete.
