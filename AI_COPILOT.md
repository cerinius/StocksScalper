# Copilot Operating Guide

## Role

Copilot is the fast in-editor helper for this repo.

Best use cases:

- local code completion
- small refactors
- repetitive boilerplate inside existing patterns
- route/service/plugin consistency
- UI component edits that follow the current shape

Copilot should not invent major architecture on its own.

## Primary Rule

Stay inside the grain of the repo.

That means:

- preserve existing file structure
- follow Fastify plugin + service patterns
- reuse Prisma and shared package helpers
- avoid creating parallel abstractions

## What To Read Before Assisting

- `overview.md`
- the current file being edited
- adjacent service/plugin files in the same module
- `packages/config/src/index.ts` if env/config is involved
- `packages/db/prisma/schema.prisma` if DB behavior is involved

## What Copilot Should Optimize For

- speed
- local consistency
- low-token suggestions
- fewer mistakes in repetitive code

## What Copilot Should Avoid

- large speculative redesigns
- adding new dependencies
- making trading or risk assumptions without checking the code
- introducing new patterns when an old one already exists nearby
- writing long comments or verbose docs unless asked

## Repo-Specific Priorities

When suggesting code, prefer:

- explicit DB writes over hidden side effects
- idempotent queue behavior
- strong logging around worker actions
- small utility reuse from `packages/*`
- API changes that remain observable in the UI

## Where Copilot Adds The Most Value

- API module endpoints and DTO shaping
- Prisma query scaffolding
- dashboard/UI table work
- worker bookkeeping code
- tests for pure functions in `packages/core`
- repetitive wiring in queue or service layers

## Where Copilot Should Be Careful

- execution worker logic
- risk throttling logic
- MT5 adapter behavior
- order/position lifecycle
- anything affecting duplicate order prevention

In those areas, correctness matters more than speed.

## Goal Alignment

The commercial goal is building a profitable platform, but Copilot contributes indirectly by making implementation faster and cleaner.

Its success metric is:

- fewer errors
- faster safe iteration
- less developer friction

That matters because speed compounds only when the system stays reliable.
