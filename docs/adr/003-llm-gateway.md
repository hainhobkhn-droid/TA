# ADR-003: Provider-neutral, budgeted LLM gateway

Status: Accepted for implementation. Date: 2026-09-08. B1 resolved: OpenAI and Anthropic API-key providers; configurable monthly cap, default 0 until configured.

## Context

LLMs help recognize Vietnamese intent/entities and phrase approved information, but cannot be a factual source. Model/provider substitution, offline tests, auditable calls and predictable cost are requirements. JSON validity and high confidence alone do not establish truth.

## Decision

Define `classify`, `extract`, `rephrase`, and `summarize` contracts with strict JSON schemas, bounded tokens, deadlines and versioned prompts. Support OpenAI and Anthropic Claude with selectable API-key configuration; retain Anthropic as the initial selection and a configurable monthly cap defaulting to 0; choose/pin a supported model and verify the current official API before implementation. No model ID, pricing or structured-output feature support is assumed here. Unknown fields, invalid schemas, timeout or provider refusal fail conservatively; no unbounded repair loop or fallback to another paid provider.

Keep a fixture implementation with deterministic inputs/outputs for offline CI. Fixture tests validate pipeline behavior; separately run and report a budgeted real-provider golden evaluation to establish model accuracy. Provider selection, model, prompt versions and usage are visible in System.

Use a Postgres budget ledger with an atomic monthly reservation before each call. Reserve a conservative upper bound based on capped input/output sizes and a configured, verified rate table. Concurrent calls must not overbook the remaining cap. Reconcile actual usage afterward; uncertain outcomes keep reservations until resolved. Use integer monetary subunits for accounting, not floating point. Retry calls need a new reservation. On exhausted cap or unknown pricing, stop paid requests and route to approved deterministic templates or human review.

Proposed budget month follows Asia/Ho_Chi_Minh, independent of user display timezone. Record estimated versus provider-reported spend and rate-table version. The cap bounds Helpa's authorized request estimates; it cannot control unrelated uses of the same API key or retroactive provider billing changes. Recommend a dedicated project/key and available provider-side spending controls when configuring B1.

Automatic replies use typed assertions rendered through approved locale templates. The model may select approved phrasing variants. Unconstrained rephrasing is retained as a draft requiring review, not an automatic-send path. The factual gate compares subject/value/unit/condition relationships, catches omissions/negations and applies forbidden-claim rules. A second LLM verdict is not proof that a first LLM added no facts.

Store exact prompt/response, operation IDs, model/prompt version, latency, usage, cost and record versions under restricted, encrypted audit storage; remove unnecessary customer identifiers before sending provider requests. Retrieved text and messages are data, never instructions to change system rules.

## Alternatives and consequences

Direct provider SDK calls from feature modules make budget enforcement and swaps hard to audit. A hosted LLM proxy adds another operational/data boundary without necessity at this scale. Free-form generation with token-matching is more fluent but cannot satisfy the stronger fact-preservation requirement.

The constrained approach trades some language variety for verifiability. Human-approved phrase/template libraries can grow without relaxing the factual contract. Phase 2 must prove budget contention, failure fallback, schema rejection, and all fact-gate safety cases.
