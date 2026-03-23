# Architecture Summary

## Overview

The platform is organized as a Docker-first TypeScript monorepo with:

- shared contracts in `packages/*`
- isolated backend and worker services in `apps/*`
- PostgreSQL for durable state
- Redis + BullMQ for orchestration and retries
- a Next.js operator UI for visibility and control

## Worker Flow

1. `worker-supervisor` schedules recurring queue jobs and watches health.
2. `worker-news` ingests and scores news intelligence, persists it, and emits alerts.
3. `worker-market` scans watchlists, computes indicator snapshots, and creates ranked trade candidates.
4. `worker-validation` attaches explainable historical validation results and backtest analogs.
5. `worker-execution` applies portfolio/risk context and produces structured execution decisions.
6. `worker-supervisor` also consumes the notification queue and dispatches Discord messages.

## Control Plane

- `apps/api` exposes operational data, manual controls, integration actions, and TradingView webhook ingestion.
- `apps/gateway` exposes SSE-based live snapshots suitable for future richer real-time dashboards.
- `apps/mt5-adapter` is the broker execution boundary. It is paper-first and intentionally isolated.

## Persistence Model

The Prisma schema covers:

- users / roles / role assignments
- integrations / integration statuses / provider configs
- worker runs / heartbeats / failures
- notifications / templates / supervisor events
- news items / symbol links
- watchlists / watchlist items
- price bars / market snapshots / trade candidates
- validation runs / backtest results
- execution decisions / orders / positions / account snapshots
- risk events / audit logs / incoming webhooks / system settings

## Safety Model

- structured execution decisions with reasons and blocking reasons
- kill switch and system setting support
- daily loss / exposure / stale signal checks in the execution engine
- duplicate prevention through candidate and decision idempotency keys
- isolated broker adapter boundary
- audit log writes for worker, user, and webhook actions

## Local Development Shape

- local-first unique ports avoid collisions with other Docker projects
- mock providers and seeded data make the system usable without external credentials
- Discord alerts suppress cleanly when no webhook is configured
- MT5 adapter starts in paper mode by default
