# StocksScalper Overview

## Mission

StocksScalper is a local-first trading control tower. Its job is to turn market data, news, watchlists, and broker state into structured trade decisions while keeping a human operator in control.

The current repo is best understood as:

- a TypeScript monorepo
- a Docker-orchestrated runtime
- a Postgres source of truth
- a Redis/BullMQ worker mesh
- a Fastify control API
- a Next.js operator console
- a broker boundary split between a TypeScript adapter and a Python MT5 bridge

The business goal is obvious: build a profitable system. The engineering goal should be more precise:

- maximize durable, risk-adjusted edge
- prefer repeatable process over one-off wins
- make every decision observable, reviewable, and testable
- upgrade realism before increasing automation

No single component in the current repo is a complete "money printer." What exists today is an extensible control system that can become one part of a serious research and execution stack.

## What Exists Today

### Runtime Topology

`docker-compose.yml` starts these services:

- `postgres`: relational system of record
- `redis`: queue backend and scheduler state
- `api`: main Fastify control plane on `4210`
- `gateway`: SSE stream service on `4211`
- `web`: Next.js operator UI on `3210`
- `mt5-adapter`: TypeScript broker-facing adapter on `4310`
- `worker-news`
- `worker-market`
- `worker-validation`
- `worker-execution`
- `worker-supervisor`

The host also runs `integrations/mt5-bridge`, a Python FastAPI bridge that talks to the actual MetaTrader5 desktop environment through the `MetaTrader5` Python package.

### Monorepo Shape

`apps/*` contains deployable services:

- `apps/api`: REST/control plane
- `apps/web`: operator dashboard and screens
- `apps/gateway`: live SSE event feed
- `apps/mt5-adapter`: broker adapter and bridge proxy
- `apps/worker-news`: news ingestion and scoring
- `apps/worker-market`: price scanning and candidate creation
- `apps/worker-validation`: validation and analog analysis
- `apps/worker-execution`: execution decisions and order placement
- `apps/worker-supervisor`: schedules, health, throttling, notifications
- `apps/worker`: legacy worker path, not the main deployed worker fleet

`packages/*` contains shared platform logic:

- `packages/config`: env parsing and runtime config
- `packages/types`: shared schemas/contracts
- `packages/logging`: logger helpers
- `packages/shared`: common utilities like hashing
- `packages/queues`: BullMQ queue factory and schedules
- `packages/core`: alpha logic, validation, execution, risk, analytics
- `packages/db`: Prisma schema, client, migrations, seed, worker run helpers

## How The System Actually Works

### Startup Flow

The practical startup flow is:

1. `START.ps1` checks Docker.
2. `START.ps1` launches `integrations/mt5-bridge/run.ps1` in a new PowerShell window.
3. Docker services build and start.
4. The API becomes healthy.
5. `worker-supervisor` ensures all repeatable BullMQ jobs exist.
6. Workers begin writing heartbeats and processing jobs.

Important detail:

- the MT5 bridge runs on the Windows host
- the TypeScript `mt5-adapter` inside Docker talks to that host bridge at `http://host.docker.internal:8000`
- if the Python bridge is missing or unhealthy, execution and account sync degrade

### Data Flow At A Glance

The current core trading loop is:

1. `worker-news` ingests news and stores scored `NewsItem` records.
2. `worker-market` pulls watchlist symbols, fetches bars, computes indicators, stores `PriceBar` and `MarketSnapshot`, and creates `TradeCandidate`.
3. `worker-validation` evaluates candidates with analog analysis and Monte Carlo, then stores `ValidationRun` and `BacktestResult`.
4. `worker-execution` evaluates validated candidates against account state and risk rules, writes `ExecutionDecision`, and optionally places an order through `mt5-adapter`.
5. Successful fills produce `Order`, `Position`, `Notification`, `AuditLog`, and `RiskEvent` records.
6. `worker-supervisor` monitors heartbeats, account state, throttles risk, manages notifications, and emits summary events.

This means the real product is not just trade placement. It is the full pipeline:

- ingest
- detect
- validate
- decide
- execute
- observe
- adapt

## Where Things Happen

### API Layer

Main entrypoint: `apps/api/src/index.ts`

The API uses a Fastify plugin + service structure for the active control-plane modules:

- `dashboard`
- `workers`
- `news`
- `trade-ideas`
- `validation`
- `execution`
- `portfolio`
- `integrations`
- `audit`
- `notifications`
- `control`
- `webhooks`

This is the current operational surface and should be treated as the main backend shape.

There are also older route files still mounted:

- `routes/backtests`
- `routes/journal`
- `routes/setups`
- `routes/symbols`
- `routes/watchlists`

These legacy-compatible routes matter because parts of the web app still rely on them, but they are not as cleanly organized as the newer module/plugin pattern.

### Web Layer

The operator UI lives in `apps/web/src/app`.

The main dashboard page at `apps/web/src/app/page.tsx` polls `/api/dashboard/summary` every 5 seconds using SWR. The web app is primarily polling-based today, even though the gateway already exposes SSE.

The UI currently acts as:

- control center
- monitoring console
- watchlist/news browser
- trade idea review panel
- validation review panel
- execution/portfolio visibility surface

This is an operator console first, not a consumer-facing app.

### Gateway Layer

`apps/gateway/src/index.ts` streams:

- latest account snapshot
- worker heartbeats
- latest risk alerts

every 5 seconds over SSE at `/events`.

Right now this is underused. It is a strong future leverage point for:

- real-time ops dashboards
- low-latency event consoles
- sidecar agents that react to system events

### Broker Boundary

There are two broker-facing components:

1. `apps/mt5-adapter`
2. `integrations/mt5-bridge`

`apps/mt5-adapter` is the internal broker API used by the rest of the platform. It can:

- proxy to the Python MT5 bridge when `MT5_BRIDGE_URL` is set
- fall back to an in-memory paper mock when no bridge is configured

`integrations/mt5-bridge/main.py` is the host-side bridge that talks to the MetaTrader5 terminal.

This split is good architecture. It keeps the rest of the system isolated from direct broker coupling. It also means:

- execution logic can be tested without real MT5
- broker transport can be swapped later
- reconciliation and safety logic have a defined boundary

## Worker Responsibilities

### `worker-news`

File: `apps/worker-news/src/index.ts`

What it does:

- gets the active watchlist
- requests symbol news from the configured news provider
- scores each article with `scoreNewsIntelligence`
- upserts `NewsItem`
- links news to symbols via `SymbolNewsLink`
- queues urgent notifications for high-urgency events
- writes worker runs and heartbeats

How it does it:

- provider selection comes from `packages/core`
- deduplication uses stable content hashing
- urgency and directionality are model-free heuristics today, not LLM reasoning

Reality check:

- the system architecture is ready for real data
- the quality of trading output remains limited by provider realism and scoring sophistication

### `worker-market`

File: `apps/worker-market/src/index.ts`

What it does:

- resolves watchlist symbols
- fetches price bars
- stores the latest bars in `PriceBar`
- loads recent symbol-linked news from Postgres
- calls `analyzeMarketCandidate`
- stores `MarketSnapshot`
- creates deduplicated `TradeCandidate`
- queues validation jobs

How it does it:

- scan loop covers configured timeframes from `WATCHLIST_TIMEFRAMES`
- each candidate is deduped by symbol + timeframe + strategy + hour bucket
- provider abstraction exists for multiple market-data providers
- optional Polygon/Massive websocket support can trigger real-time scans

This worker is the front door of alpha creation.

### `worker-validation`

File: `apps/worker-validation/src/index.ts`

What it does:

- loads new/validating candidates
- marks them `VALIDATING`
- finds analog patterns using stored price history
- falls back to adaptive synthetic analogs when history is too thin
- calls `validateCandidate`
- runs `runMonteCarloSimulation`
- stores `ValidationRun` and `BacktestResult`
- updates candidate status to `VALIDATED` or `REJECTED`
- queues execution for passing candidates

How it does it:

- uses recent `PriceBar` history from Postgres
- computes return-pattern similarity using Pearson correlation
- uses actual forward outcomes when enough real history exists

This is one of the strongest parts of the current repo because it is trying to ground validation in stored market history instead of pure narrative logic.

### `worker-execution`

File: `apps/worker-execution/src/index.ts`

What it does:

- syncs account state from `mt5-adapter`
- persists `AccountSnapshot`
- loads validated candidates
- computes dynamic risk per trade from system settings and recent streaks
- measures correlated exposure
- requests broker quote/spread context
- calls `makeExecutionDecision`
- stores `ExecutionDecision`
- places orders through `mt5-adapter` when action is `PLACE`
- stores resulting `Order` and `Position`
- records `RiskEvent` and `AuditLog`
- queues execution notifications

How it does it:

- idempotency keys prevent duplicate decisions within a time window
- spread filters and correlation filters are enforced before auto-placement
- decisions are explainable and persist reasons plus blocking reasons

This worker is the safety-critical center of the platform.

### `worker-supervisor`

File: `apps/worker-supervisor/src/index.ts`

What it does:

- ensures default schedules exist in BullMQ
- monitors worker heartbeat freshness
- summarizes account and worker risk
- lowers dynamic max risk per trade when actual performance lags expected edge
- manages ATR-based trailing stop updates
- creates `SupervisorEvent`
- persists/sends notifications
- emits daily summaries

How it does it:

- schedules come from `packages/queues`
- state comes from Postgres
- notification dedupe is hash-based
- Discord delivery is optional and suppresses cleanly when unconfigured

The supervisor is the system’s meta-operator.

## Persistence Model

Main schema file: `packages/db/prisma/schema.prisma`

The database is not just for trades. It stores the whole operating history of the platform:

- identities and roles
- integrations and statuses
- worker runs, failures, and heartbeats
- news intelligence and symbol links
- watchlists and watchlist items
- price bars and market snapshots
- trade candidates
- validation runs and backtest results
- execution decisions
- orders and positions
- account snapshots
- risk events
- notifications and supervisor events
- audit logs
- incoming webhooks
- system settings

This is a strong design decision because it makes the system observable and replayable.

## Configuration Model

Main file: `packages/config/src/index.ts`

Important config domains:

- ports and service URLs
- provider selection
- watchlist symbols and timeframes
- queue/schedule intervals
- trading mode
- manual approval and kill switch
- risk limits
- Monte Carlo and correlation settings
- local admin identity

One notable reality shift:

- README still emphasizes mock/local-first behavior
- config defaults now allow real providers like `yahoo_finance` and `finnhub`

So the repo is partway between prototype and real system. The docs and code do not always tell the same story. Future work should keep them aligned.

## Auth And Operator Model

Auth is intentionally lightweight right now.

Protected API routes identify a user via:

- `x-user-email`
- fallback local admin identity from config

This is enough for local development and internal tooling, but it is not production-grade auth.

## Seed Data And Bootstrapping

Seed script: `packages/db/src/seed.ts`

The seed creates:

- roles
- a local admin
- MT5 and Discord integrations
- a watchlist
- symbols
- worker heartbeat placeholders
- notification templates
- dynamic risk settings

The seed exists to make the whole control tower usable immediately.

One important nuance:

- seed data is structural and operational
- it is not proof that the strategy has live alpha

## Legacy And Transitional Parts

These parts deserve special attention:

- `apps/worker` is a legacy path not used by the current Docker worker fleet
- some web pages rely on older route patterns
- the gateway is available but underused
- the adapter/bridge split is sound, but modify/reconcile flows are incomplete
- some comments/docs still describe mock-first operation while config defaults already lean more realistic

This means the repo is not greenfield. It is a transitioning system with both a modern path and older compatibility surfaces.

## What Makes Money Here

If the goal is to turn this into a serious wealth-building system, the real leverage is not "add more random AI." It is improving the quality of the decision loop.

The profit engine, in order, is:

1. better data
2. better candidate generation
3. better validation
4. better sizing and portfolio construction
5. better execution quality
6. better monitoring and feedback loops

The current repo already has scaffolding for all six, but several parts are still immature.

## Highest-Leverage Gaps

### 1. Provider Realism Is Still A Bottleneck

The system can use real providers, but provider integration quality is uneven and the repo still carries prototype assumptions. Better edge starts with cleaner, faster, richer data.

### 2. There Is No Proper Research Feedback Loop Yet

Candidates, validations, and executions are stored, but there is not yet a first-class closed-loop learning layer that asks:

- which signals truly work by regime
- which provider inputs add net value
- which setups decay over time
- when should a strategy auto-throttle or auto-disable

### 3. Broker Reconciliation Needs To Mature

Execution is much safer when the system regularly reconciles:

- platform positions vs broker positions
- platform orders vs broker orders
- expected stops/take-profits vs actual broker state

### 4. The UI Is Strong On Visibility, Weak On Research Control

The operator can see the system, but the platform still needs better tooling for:

- ranking signal families
- replaying decision quality
- comparing regime performance
- tagging strategy variants
- running controlled experiments

### 5. AI Is Not Yet A First-Class Runtime Worker

Today the AI is mostly outside the runtime. The repo does not yet have:

- a research-agent queue
- an experiment planner worker
- a nightly strategy-review worker
- a post-trade forensic worker

Those are real opportunities.

## Practical AI Opportunities

### Local Ollama As A Sidecar

Since Ollama is installed on this machine, a sensible near-term use is not broker-facing autonomy. It is low-cost sidecar intelligence for tasks like:

- summarizing daily risk events
- clustering similar trade failures
- tagging news themes
- generating post-trade review notes
- ranking candidate explanations for operator review
- writing nightly research summaries from DB snapshots

That should happen behind a strict boundary:

- AI suggests
- risk engine decides
- broker adapter executes

### Multi-Agent Pattern Worth Building

The safest high-leverage worker expansion would be:

- `worker-research`: mines historical trades and validations for recurring winners/losers
- `worker-review`: produces daily or weekly forensic summaries
- `worker-regime`: tracks which setup families work in which market regimes
- `worker-experiment`: proposes parameter tests, not live changes

These should write artifacts, rankings, and recommendations before they are allowed to influence live execution.

## Suggested Development Priorities

If the mission is "make this system truly valuable," these are the best next moves:

1. unify docs and code around what is live, mocked, legacy, and experimental
2. harden broker reconciliation and position lifecycle management
3. build performance attribution by strategy, regime, symbol cluster, and timeframe
4. create a research loop that converts stored outcomes into parameter updates
5. upgrade candidate generation with richer features and regime-aware ranking
6. promote SSE/event-driven ops over polling where it matters
7. add AI sidecars for analysis, summaries, and experiment planning

## Ground Truth Summary

What this repo is:

- a serious early-stage trading operations platform
- already capable of ingesting, scanning, validating, deciding, and placing paper/live-adjacent trades
- architecturally stronger than a toy bot

What it is not yet:

- a proven fully autonomous production trading machine
- a guaranteed wealth engine
- a complete institutional research stack

What matters most next:

- improve the edge loop
- improve realism
- improve observability
- improve learning
- let AI amplify those layers without bypassing safety
