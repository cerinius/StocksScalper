# Current Strategy and Full Project Overview

Generated: 2026-04-22
Scope: Entire repository, all workers, all apps, all packages, infrastructure, and full file manifest.

## 1) What this project is

StocksScalper is a local-first trading control tower. It runs a multi-service platform that ingests market/news context, generates trade candidates, validates them with analog + Monte Carlo logic, applies risk-gated execution, and presents everything through an operator UI and API.

The repo is a monorepo using npm workspaces:
- apps/* for deployable services
- packages/* for shared domain logic and infra helpers
- docker-compose for full local orchestration (Postgres + Redis + services)

## 2) Runtime architecture and process flow

Primary data and control flow:
1. Worker scheduling is initialized through BullMQ repeat jobs.
2. News worker ingests/scored news and stores linked symbol intelligence.
3. Market worker scans symbols/timeframes and creates trade candidates.
4. Validation worker finds analogs, computes expectancy/risk, writes validation runs.
5. Execution worker applies hard risk + correlation checks and places paper/live-proxied orders.
6. Supervisor worker monitors health, syncs account/positions, applies dynamic risk throttles, and emits notifications.
7. API exposes all state/actions to the web frontend.
8. Gateway streams live snapshots over SSE.

## 3) Infrastructure and orchestration in place

From docker-compose and Dockerfiles:
- postgres (state store)
- redis (BullMQ queue backend)
- api (Fastify control plane)
- gateway (SSE stream)
- web (Next.js UI)
- mt5-adapter (TS bridge/proxy + mock fallback)
- worker-news
- worker-market
- worker-validation
- worker-execution
- worker-supervisor

Operational sequencing:
- Postgres/Redis healthy first
- MT5 adapter starts
- API starts and exposes health/docs
- Gateway and workers start after API health
- Web starts after API + Gateway health

## 4) Service-by-service behavior

### apps/api
Entrypoint: apps/api/src/index.ts

Responsibilities:
- registers middleware/security/docs: CORS, helmet, swagger, swagger-ui
- exposes health/session
- mounts plugin-based modules for dashboard/workers/news/trade ideas/validation/execution/portfolio/integrations/audit/notifications/control/webhooks
- keeps legacy routes for journal/setups/symbols/backtests/watchlists

Process in place:
- request auth via auth prehandler (header-based local user model)
- role-gated operational controls (jobs, kill switch, integrations)
- all feature state served from DB-backed services

### apps/web
Entrypoint: apps/web/src/app/*

Responsibilities:
- operator UI for dashboard, workers, news, trade ideas, validation, execution, portfolio, audit, notifications, integrations, watchlists, journal, setups, research, symbols
- fetches data from API endpoints, with refresh/polling behavior on key screens

Process in place:
- page-level panels map directly to API modules
- UI composes shared table/filter/reasoning components

### apps/gateway
Entrypoint: apps/gateway/src/index.ts

Responsibilities:
- /health and /events SSE endpoint
- periodic stream of account snapshot, worker heartbeat, and risk alerts

Process in place:
- interval polling from DB every 5s and push to connected clients

### apps/mt5-adapter
Entrypoint: apps/mt5-adapter/src/index.ts

Responsibilities:
- broker-facing abstraction for account/positions/orders/quotes/connect/disconnect
- proxy to Python MT5 bridge when MT5_BRIDGE_URL is configured
- fallback mock mode when bridge unavailable

Process in place:
- normalizes upstream bridge responses to internal shape
- enforces request timeout to keep workers resilient

## 5) Worker-by-worker full process map

### apps/worker (legacy)
Entrypoint: apps/worker/src/index.ts
- legacy worker shell retained in repo
- contains older jobs under apps/worker/src/jobs/*

### apps/worker-news
Entrypoint: apps/worker-news/src/index.ts

Input:
- queue payload (urgent/broad sweep)
- active watchlist symbols
- configured news provider

Core processing:
1. create worker run + heartbeat
2. fetch news per watchlist symbols
3. score each article (urgency/bias/relevance/volatility/confidence)
4. dedupe + upsert NewsItem
5. maintain SymbolNewsLink
6. queue urgent notifications for high/critical items
7. write run completion metrics

Output tables/events:
- NewsItem
- SymbolNewsLink
- Notification queue
- WorkerRun/Heartbeat/Failure

### apps/worker-market
Entrypoint: apps/worker-market/src/index.ts

Input:
- queue payload (scan)
- watchlist symbols + configured timeframes
- market data provider bars
- recent linked news context

Core processing:
1. heartbeat + worker run lifecycle
2. upsert tracked symbols
3. fetch/persist recent bars to PriceBar
4. analyze setup with indicator/news confluence
5. create MarketSnapshot
6. dedupe and create TradeCandidate
7. audit decision record for candidate creation
8. enqueue candidate for validation

Output tables/events:
- PriceBar
- MarketSnapshot
- TradeCandidate
- AuditLog
- Validation queue events

### apps/worker-validation
Entrypoint: apps/worker-validation/src/index.ts

Input:
- new/pending candidate IDs
- historical PriceBar series from DB

Core processing:
1. set candidate status validating
2. find real historical analog windows via Pearson similarity
3. derive outcomes and fallback to adaptive synthetic analogs when history is insufficient
4. run validateCandidate metrics and Monte Carlo simulation
5. persist ValidationRun
6. update candidate status and enqueue execution

Output tables/events:
- ValidationRun
- TradeCandidate status transitions
- Execution queue events
- WorkerRun/Heartbeat/Failure

### apps/worker-execution
Entrypoint: apps/worker-execution/src/index.ts

Input:
- validated candidates
- account snapshot from MT5 adapter
- open positions + recent closes + config risk controls

Core processing:
1. sync/load account state
2. compute dynamic risk per trade including streak scaling
3. evaluate correlation context with existing exposure
4. pull quote/spread context
5. run decision engine (PLACE/HOLD/SKIP/INVALIDATE)
6. record ExecutionDecision + audit/risk events
7. if PLACE, submit order to adapter and persist order/position links

Output tables/events:
- AccountSnapshot
- ExecutionDecision
- Order
- Position
- RiskEvent
- AuditLog

### apps/worker-supervisor
Entrypoint: apps/worker-supervisor/src/index.ts

Input:
- worker heartbeat data
- account/position state
- recent execution/validation performance

Core processing:
1. ensure default schedules exist in BullMQ
2. monitor worker lag/health and emit notifications
3. sync MT5 account snapshot and reconcile positions
4. dynamically throttle risk settings in SystemSetting when drawdown/performance pressures trigger
5. produce daily summary and supervisory alerts

Output tables/events:
- WorkerHeartbeat updates
- SystemSetting (risk.dynamicControls)
- AccountSnapshot and position reconciliations
- RiskEvent
- Notification queue
- AuditLog

## 6) Queue and scheduling processes in place

From packages/queues/src/index.ts:
- queue names:
  - queue-news-intelligence
  - queue-market-analysis
  - queue-validation
  - queue-execution
  - queue-supervisor
  - queue-notifications
- worker concurrency is 1 per queue worker instance
- default retry/backoff policy configured in queue options
- ensureDefaultSchedules registers repeat jobs:
  - urgentSweep
  - broadSweep
  - scanWatchlist
  - periodicValidation
  - executionLoop
  - healthCheck
  - dailySummary

## 7) Shared package responsibilities

### packages/config
- typed environment/config parser and default platform configuration
- central source for ports, URLs, schedules, risk limits, provider selection

### packages/core
- domain engines: news intelligence, market scan/setup analysis, validation, Monte Carlo, execution decision logic, risk correlation/Kelly, supervisor summaries

### packages/db
- Prisma schema + migrations + seed + worker helper functions
- durable model layer for all platform state

### packages/logging
- structured logger helpers for all services

### packages/queues
- queue factories, worker wrappers, schedule synchronization, notification enqueue helpers

### packages/shared
- utility math/hash/reasoning helpers used across services

### packages/types
- shared TypeScript contracts/schemas between apps/packages

## 8) API + UI process map

API modules expose operational state:
- dashboard, workers, news, trade ideas, validation, execution, portfolio, integrations, audit, notifications, control, webhooks

UI pages reflect those modules and provide an operator control tower surface for:
- monitoring worker health/risk
- reviewing ideas and validation evidence
- inspecting execution decisions and outcomes
- managing integrations/watchlists/journal/setups

## 9) MT5 bridge process

Python integration located at integrations/mt5-bridge provides FastAPI endpoints to an MT5 runtime. The TypeScript mt5-adapter proxies into this bridge in live-bridge mode, or falls back to mock mode for local reliability.

## 10) Scripts, docs, and operational wrappers

- scripts/sync-mt5-history.ts: historical sync utility
- scripts/test-integrations.ts: integration test harness
- START.ps1 and RESET.ps1: environment startup/reset helpers
- docs/architecture.md and docs/roadmap.md: system-level design and roadmap
- strategy-audit-and-logic.md, overview.md, finalOverview.md: design and process writeups

## 11) Data/process controls currently in place

- DB-backed audit trail for actions and worker outcomes
- heartbeat + worker run tracking for observability
- risk gating before execution (kill switch, spread, exposure, correlation, drawdown)
- dynamic supervisor risk throttling via system setting overrides
- notification dedupe via stable hash keys
- role-based route controls for sensitive operations

## 12) Full repository file manifest (no file skipped)

The following list is generated from rg --files at generation time.

- AI_CLAUDE.md
- AI_CODEX.md
- AI_COPILOT.md
- CurrentStrategy.md
- README.md
- RESET.ps1
- START.ps1
- UPGRADE_NOTES.md
- apps/api/package.json
- apps/api/src/index.ts
- apps/api/src/lib/audit.ts
- apps/api/src/lib/auth.ts
- apps/api/src/lib/http.test.ts
- apps/api/src/lib/http.ts
- apps/api/src/modules/audit/plugin.ts
- apps/api/src/modules/audit/service.ts
- apps/api/src/modules/control/plugin.ts
- apps/api/src/modules/control/service.ts
- apps/api/src/modules/dashboard/plugin.ts
- apps/api/src/modules/dashboard/service.ts
- apps/api/src/modules/execution/plugin.ts
- apps/api/src/modules/execution/service.ts
- apps/api/src/modules/integrations/plugin.ts
- apps/api/src/modules/integrations/service.ts
- apps/api/src/modules/news/plugin.ts
- apps/api/src/modules/news/service.ts
- apps/api/src/modules/notifications/plugin.ts
- apps/api/src/modules/notifications/service.ts
- apps/api/src/modules/portfolio/plugin.ts
- apps/api/src/modules/portfolio/service.ts
- apps/api/src/modules/trade-ideas/plugin.ts
- apps/api/src/modules/trade-ideas/service.test.ts
- apps/api/src/modules/trade-ideas/service.ts
- apps/api/src/modules/validation/plugin.ts
- apps/api/src/modules/validation/service.ts
- apps/api/src/modules/webhooks/plugin.ts
- apps/api/src/modules/webhooks/service.ts
- apps/api/src/modules/workers/plugin.ts
- apps/api/src/modules/workers/service.ts
- apps/api/src/routes/backtests.ts
- apps/api/src/routes/dashboard.ts
- apps/api/src/routes/jobs.ts
- apps/api/src/routes/journal.ts
- apps/api/src/routes/mt5/index.ts
- apps/api/src/routes/setups.ts
- apps/api/src/routes/symbols.ts
- apps/api/src/routes/tradingview.ts
- apps/api/src/routes/universe.ts
- apps/api/src/routes/watchlists.ts
- apps/api/src/services/analytics.ts
- apps/api/src/services/mt5Client.ts
- apps/api/src/services/providers.test.ts
- apps/api/src/services/providers.ts
- apps/api/src/services/queues.ts
- apps/api/tsconfig.json
- apps/gateway/package.json
- apps/gateway/src/index.ts
- apps/gateway/tsconfig.json
- apps/mt5-adapter/package.json
- apps/mt5-adapter/src/index.ts
- apps/mt5-adapter/tsconfig.json
- apps/web/next-env.d.ts
- apps/web/next.config.js
- apps/web/package.json
- apps/web/scripts/run-next.js
- apps/web/src/app/audit/page.tsx
- apps/web/src/app/execution/page.tsx
- apps/web/src/app/globals.css
- apps/web/src/app/integrations/page.tsx
- apps/web/src/app/journal/page.tsx
- apps/web/src/app/layout.tsx
- apps/web/src/app/news/page.tsx
- apps/web/src/app/notifications/page.tsx
- apps/web/src/app/page.tsx
- apps/web/src/app/portfolio/page.tsx
- apps/web/src/app/research/page.tsx
- apps/web/src/app/setups/page.tsx
- apps/web/src/app/symbols/[ticker]/page.tsx
- apps/web/src/app/trade-ideas/page.tsx
- apps/web/src/app/validation/page.tsx
- apps/web/src/app/watchlists/WatchlistManager.tsx
- apps/web/src/app/watchlists/page.tsx
- apps/web/src/app/workers/page.tsx
- apps/web/src/components/data-table.tsx
- apps/web/src/components/empty-state.tsx
- apps/web/src/components/filter-chips.tsx
- apps/web/src/components/list-toolbar.tsx
- apps/web/src/components/reason-list.tsx
- apps/web/src/components/screen.tsx
- apps/web/src/lib/api.test.ts
- apps/web/src/lib/api.ts
- apps/web/tsconfig.json
- apps/worker-execution/package.json
- apps/worker-execution/src/index.ts
- apps/worker-execution/tsconfig.json
- apps/worker-market/package.json
- apps/worker-market/src/index.ts
- apps/worker-market/src/ws.d.ts
- apps/worker-market/tsconfig.json
- apps/worker-news/package.json
- apps/worker-news/src/index.ts
- apps/worker-news/src/test-integrations.ts
- apps/worker-news/tsconfig.json
- apps/worker-supervisor/package.json
- apps/worker-supervisor/src/index.ts
- apps/worker-supervisor/tsconfig.json
- apps/worker-validation/package.json
- apps/worker-validation/src/index.ts
- apps/worker-validation/tsconfig.json
- apps/worker/package.json
- apps/worker/src/index.ts
- apps/worker/src/jobs/dailyUpdate.ts
- apps/worker/src/jobs/intradayScan.ts
- apps/worker/src/jobs/weeklyUniverseRefresh.ts
- apps/worker/tsconfig.json
- docker-compose.yml
- docker/Dockerfile.api
- docker/Dockerfile.gateway
- docker/Dockerfile.mt5-adapter
- docker/Dockerfile.mt5-bridge
- docker/Dockerfile.web
- docker/Dockerfile.worker-execution
- docker/Dockerfile.worker-market
- docker/Dockerfile.worker-news
- docker/Dockerfile.worker-supervisor
- docker/Dockerfile.worker-validation
- docs/architecture.md
- docs/roadmap.md
- examples/tradingview-alert.json
- finalOverview.md
- integrations/mt5-bridge/__pycache__/config.cpython-314.pyc
- integrations/mt5-bridge/__pycache__/main.cpython-314.pyc
- integrations/mt5-bridge/__pycache__/mt5_client.cpython-314.pyc
- integrations/mt5-bridge/__pycache__/schemas.cpython-314.pyc
- integrations/mt5-bridge/config.py
- integrations/mt5-bridge/main.py
- integrations/mt5-bridge/mt5_client.py
- integrations/mt5-bridge/requirements.txt
- integrations/mt5-bridge/run.ps1
- integrations/mt5-bridge/schemas.py
- overview.md
- package-lock.json
- package.json
- packages/config/package.json
- packages/config/src/index.test.ts
- packages/config/src/index.ts
- packages/config/tsconfig.json
- packages/core/package.json
- packages/core/src/analysis/indicators.ts
- packages/core/src/analysis/intelligence.ts
- packages/core/src/analysis/market-scan.ts
- packages/core/src/analysis/regime.test.ts
- packages/core/src/analysis/regime.ts
- packages/core/src/analytics/backtest.test.ts
- packages/core/src/analytics/backtest.ts
- packages/core/src/analytics/monte-carlo.test.ts
- packages/core/src/analytics/monte-carlo.ts
- packages/core/src/execution/decision-engine.test.ts
- packages/core/src/execution/decision-engine.ts
- packages/core/src/index.ts
- packages/core/src/news/intelligence.test.ts
- packages/core/src/news/intelligence.ts
- packages/core/src/providers/alpha-vantage-market.ts
- packages/core/src/providers/alpha-vantage.ts
- packages/core/src/providers/execution.ts
- packages/core/src/providers/finnhub-news.ts
- packages/core/src/providers/index.ts
- packages/core/src/providers/market-data.ts
- packages/core/src/providers/massive.test.ts
- packages/core/src/providers/massive.ts
- packages/core/src/providers/mock.test.ts
- packages/core/src/providers/mock.ts
- packages/core/src/providers/news.ts
- packages/core/src/providers/polygon.ts
- packages/core/src/providers/yahoo-finance-market.ts
- packages/core/src/risk/correlation.test.ts
- packages/core/src/risk/correlation.ts
- packages/core/src/risk/kelly.test.ts
- packages/core/src/risk/kelly.ts
- packages/core/src/scoring/normalize.test.ts
- packages/core/src/scoring/normalize.ts
- packages/core/src/setups/scalp.ts
- packages/core/src/setups/setups.test.ts
- packages/core/src/setups/swing.ts
- packages/core/src/supervisor/health.ts
- packages/core/src/types.ts
- packages/core/src/validation/score.ts
- packages/core/tsconfig.json
- packages/db/package.json
- packages/db/prisma/migrations/20260323_platform_init/migration.sql
- packages/db/prisma/migrations/20260324_notification_dedupe_unique/migration.sql
- packages/db/prisma/migrations/migration_lock.toml
- packages/db/prisma/schema.prisma
- packages/db/src/index.ts
- packages/db/src/seed.ts
- packages/db/src/workers.ts
- packages/db/tsconfig.json
- packages/logging/package.json
- packages/logging/src/index.ts
- packages/logging/tsconfig.json
- packages/queues/package.json
- packages/queues/src/index.ts
- packages/queues/tsconfig.json
- packages/shared/package.json
- packages/shared/src/copy.ts
- packages/shared/src/index.ts
- packages/shared/src/pagination.test.ts
- packages/shared/src/pagination.ts
- packages/shared/src/reasoning.test.ts
- packages/shared/src/reasoning.ts
- packages/shared/tsconfig.json
- packages/types/package.json
- packages/types/src/index.ts
- packages/types/tsconfig.json
- scripts/sync-mt5-history.ts
- scripts/test-integrations.ts
- strategy-audit-and-logic.md
- tsconfig.base.json
- web_log.txt
