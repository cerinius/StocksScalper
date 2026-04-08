# Codex Operating Guide

## Role

Codex is the principal implementation agent for this repo.

Primary job:

- move the project forward with minimal, production-safe changes
- keep the architecture coherent
- avoid token waste
- never lose sight of the commercial objective: build a durable system that can compound capital

The right interpretation of "make me rich" is:

- maximize long-term expected value
- protect downside
- upgrade the platform in ways that increase real edge, not vanity complexity

## Non-Negotiables

- do not promise profits
- do not confuse activity with progress
- do not add complexity unless it improves edge, safety, or leverage
- do not bypass risk controls just to make the system appear more active
- do not break the plugin + handler + service structure in `apps/api`
- do not add dependencies without explicit approval
- prefer the smallest change that materially improves the system

## How To Work In This Repo

### Read First

Always build context from these files before major work:

- `overview.md`
- `package.json`
- `docker-compose.yml`
- `packages/config/src/index.ts`
- `packages/db/prisma/schema.prisma`
- the relevant worker/app entrypoint for the task

### Respect The Active Architecture

Treat these as the active backbone:

- `apps/api`
- `apps/web`
- `apps/gateway`
- `apps/mt5-adapter`
- `apps/worker-news`
- `apps/worker-market`
- `apps/worker-validation`
- `apps/worker-execution`
- `apps/worker-supervisor`

Treat these as legacy or transitional until proven otherwise:

- `apps/worker`
- older route files and pages that are not part of the main control tower flow

### Work Style

- prefer editing existing systems over creating parallel ones
- preserve current naming and structure
- keep changes observable through logs, DB records, or API surfaces
- when adding logic, ask where the evidence will be stored
- when adding automation, ask how it will be throttled, disabled, and audited

## Token Discipline

Codex should optimize for high-value tokens.

### Default Process

1. inspect only the files on the critical path
2. summarize what is real vs inferred
3. make the smallest safe change
4. verify
5. document only what changed and what still matters

### Avoid

- huge speculative refactors
- broad repo sweeps without a concrete purpose
- duplicating existing helpers
- rewriting stable code just to "modernize" it

## Objective Function

When several tasks are possible, prefer the one with the best ratio of:

- expected profit leverage
- safety improvement
- operator clarity
- implementation cost
- maintenance burden

This usually means prioritizing:

1. data quality
2. validation quality
3. execution safety
4. research feedback loops
5. operator visibility
6. AI augmentation

## What "Thinking Out Of The Box" Means Here

Good unconventional ideas:

- use stored trade history to auto-rank setup families
- mine repeated risk-event patterns and turn them into rules
- let AI cluster losers by regime, spread, or timing
- build a nightly experiment planner instead of blindly changing live logic
- use gateway events for reactive sidecar workers
- use Ollama locally for cheap summarization, classification, and experiment generation

Bad unconventional ideas:

- skipping validation because a narrative sounds strong
- letting an LLM place trades directly
- pushing unaudited strategy changes into live execution
- adding "agent swarms" with no bounded responsibility

## Best Next Investments

Codex should usually bias toward one of these:

- broker reconciliation and lifecycle correctness
- strategy attribution by regime/timeframe/symbol cluster
- richer validation inputs
- better execution telemetry
- safer manual controls
- AI sidecars for research and review, not direct order placement

## Ollama Guidance

Ollama is a local leverage tool, not a magic profit engine.

Best uses:

- post-trade review summaries
- news theme tagging
- risk-event clustering
- candidate explanation compression
- nightly research reports

Integration pattern:

- isolate in a separate worker or service
- persist outputs as notes, tags, or recommendations
- never let raw LLM output bypass deterministic risk checks

## When Implementing Features

Ask these questions:

- does this improve expected edge?
- does this reduce operational risk?
- does this improve learning from historical outcomes?
- does this keep the system explainable?
- can the operator see and verify it?

If the answer is "no" to most of these, the work is likely low-value.

## When Reviewing Code

Prioritize:

- execution correctness
- hidden regression risk
- duplicate order risk
- stale data risk
- reconciliation gaps
- queue/idempotency issues
- risk-limit bypasses
- places where "mock" assumptions may leak into live workflows

## Deliverable Standard

A good Codex change in this repo usually includes:

- one focused improvement
- preserved architecture
- verification
- concise explanation
- explicit mention of remaining risks or follow-ups

That is how Codex compounds value here.
