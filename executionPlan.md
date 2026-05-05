# executionPlan.md

**Master blueprint and execution roadmap for evolving StocksScalper into a local-first, multi-account funded-trading operating system.**

Owner: Ekjot Singh
Principal architect of record: this document
Repo: `stock-radar` monorepo (npm workspaces, TypeScript, Prisma, BullMQ, Fastify, Next.js, Python MT5 bridge)
Date: 2026-04-22
Status: AUTHORITATIVE PLAN — all future work should be reconciled against this file.

---

## 0. How to read and use this document

This file has four jobs:

1. **Ground truth of where we are today** (Section 2). Every paragraph in Section 2 references a file or subsystem that already exists in the repo. If code drifts from this section, update Section 2 first.
2. **Honest gap analysis** (Section 3). What is safely reusable, what must be refactored, what must be built. Labelled REUSE / EXTEND / REFACTOR / NEW so work can be estimated cleanly.
3. **Target architecture + domain model** (Sections 4–8). The system we are evolving toward. Phase-aware, multi-account, AI-assisted, LAN-safe, survivability-first.
4. **Phased implementation roadmap** (Section 14). Commit-shaped checkpoints. Nothing in this roadmap does a big-bang rewrite; every phase keeps the repo runnable.

Read Sections 0–5 before making any architectural edit. Read Section 14 before starting any PR.

---

## 1. North Star and non-negotiable product principles

We are not trying to maximise the number of trades. We are building a **funded-account survival and compounding system** that:

- protects funded accounts above everything else
- passes prop challenge phases without rule breaches
- refuses to spray the same setup across every account
- supervises open trades actively and intervenes early
- uses a locally hosted LLM as a critic/reviewer/supervisor, never as the trader
- always defaults to conservative behaviour when uncertain
- enforces deterministic hard rules that the LLM cannot override
- is explainable, observable, composable, auditable, local-first

Design bias, in priority order: **survivability → explainability → composability → observability → local reliability → disciplined execution → opportunistic yield**.

---

## 2. Current state (grounded in the actual repo)

### 2.1 Topology (what exists today)

Monorepo layout: `apps/*` (9 services) + `packages/*` (7 shared libs) + `integrations/mt5-bridge` (Python) + `docker/*` (Dockerfiles) + `docs/*` (architecture.md, roadmap.md) + PowerShell launchers (`START.ps1`, `RESET.ps1`).

Services (from `docker-compose.yml`):

- **postgres** (`:55432`) — primary source of truth
- **redis** (`:56379`) — BullMQ backend
- **apps/api** (Fastify, `:4210`) — plugin-based control plane; modules: `audit`, `control`, `dashboard`, `execution`, `integrations`, `news`, `notifications`, `portfolio`, `trade-ideas`, `validation`, `webhooks`, `workers` + legacy routes (`journal`, `setups`, `symbols`, `watchlists`, `research`).
- **apps/gateway** (Fastify SSE, `:4211`) — polls DB every 5s and streams `AccountSnapshot`, `WorkerHeartbeat`, `RiskEvent` events.
- **apps/web** (Next.js, `:3210`) — 14 pages already exist (dashboard, workers, news, trade-ideas, validation, execution, portfolio, integrations, audit, notifications, watchlists, journal, setups, research, symbols).
- **apps/mt5-adapter** (Fastify, `:4310`) — TypeScript proxy to the Python bridge with in-memory paper-trading fallback.
- **apps/worker-news** — ingest, score, dedupe, link news.
- **apps/worker-market** — scan bars, compute indicators, generate `TradeCandidate`s.
- **apps/worker-validation** — find real analogs + Monte Carlo fallback, write `ValidationRun`.
- **apps/worker-execution** — run risk gates, size, place orders via `mt5-adapter`.
- **apps/worker-supervisor** — BullMQ scheduler, health monitor, notification dispatcher, kill-switch watcher.
- **apps/worker** — deprecated shell, retained.
- **integrations/mt5-bridge** (Python 3 FastAPI, `:8000`, on Windows host) — wraps `MetaTrader5` Python package; exposes `/health`, `/account`, `/positions`, `/orders`, `/history`, `/symbols/:symbol/tick`, `POST /orders`, `POST /positions/:id/close`.

Packages:

- `@stock-radar/types` — zod contracts, shared enums.
- `@stock-radar/config` — env parsing with zod (`getPlatformConfig()`).
- `@stock-radar/db` — Prisma client singleton + worker-run helpers (`createWorkerRun`, `upsertWorkerHeartbeat`, `completeWorkerRun`, `failWorkerRun`).
- `@stock-radar/logging` — structured logger.
- `@stock-radar/shared` — `stableHash`, `reasoning.ts` (`buildReasoningLog`, `buildDecisionRecord`, `DECISION_CODES`), pagination, copy helpers.
- `@stock-radar/queues` — BullMQ queue/schedule factories (`news-jobs`, `market-jobs`, `validation-jobs`, `execution-jobs`, `supervisor-jobs`, `notifications`).
- `@stock-radar/core` — the brain:
  - `analysis/market-scan.ts` (vote-based 10-signal-group direction inference), `analysis/intelligence.ts`, `analysis/regime.ts`, `analysis/indicators.ts`
  - `analytics/backtest.ts` (Monte Carlo, drawdown, RoR)
  - `execution/decision-engine.ts` (`makeExecutionDecision` — this is the deterministic rule gate; currently 399 lines covering: kill switch, daily loss, max active trades, total exposure, symbol exposure, correlated exposure, spread, stale signal, manual approval, validation score; emits `StructuredDecision` with `reasons`, `blockingReasons`, `supportingReferences`)
  - `risk/correlation.ts`, `risk/kelly.ts` (half-Kelly sizing)
  - `scoring/normalize.ts` (multi-factor weighting)
  - `setups/swing.ts`, `setups/scalp.ts`
  - `supervisor/health.ts`
  - `validation/score.ts` (Pearson correlation analog scoring)
  - `providers/*` (yahoo-finance, polygon, alpha-vantage, massive, finnhub-news, mock, plus a stub `execution.ts`)

### 2.2 Prisma domain (what the DB looks like today)

Schema: `packages/db/prisma/schema.prisma` (~772 lines). Migrations: `20260323_platform_init`, `20260324_notification_dedupe_unique`.

Enums (partial, relevant here): `AssetClass`, `UserRoleKey`, `IntegrationKind {DISCORD, TRADINGVIEW, MT5, MARKET_DATA, NEWS_DATA}`, `IntegrationStatusType`, `WorkerType`, `WorkerRunStatus`, `Severity`, `NewsDirection`, `NewsUrgency`, `VolatilityImpact`, `CandidateStatus`, `ValidationStatus`, `ExecutionAction`, `ExecutionDecisionStatus`, `TradingMode {PAPER, LIVE}`, `OrderStatus`, `PositionStatus`, `RiskState {NORMAL, CAUTION, BLOCKED, KILL_SWITCH}`, `NotificationChannel`, `NotificationStatus`, `WebhookKind`, `WebhookProcessingStatus`, `ActorType`.

Models (grouped):

- User/Auth: `User`, `Role`, `UserRole`.
- Market data: `Symbol`, `PriceBar`, `MarketSnapshot`.
- News: `NewsItem`, `SymbolNewsLink`.
- Watchlists: `Watchlist`, `WatchlistItem`.
- Candidates: `TradeCandidate`, `ValidationRun`, `BacktestResult`.
- Execution: `ExecutionDecision` (has `idempotencyKey @unique`), `Order` (has `brokerOrderId @unique`, nullable `integrationId`, nullable `decisionId`), `Position` (has nullable `orderId`, nullable `brokerPositionId`, **no accountId**), `AccountSnapshot` (has nullable `integrationId`, time-series of balance/equity/margin/pnl/drawdown/riskState/killSwitchActive).
- Risk/observability: `RiskEvent`, `AuditLog`, `NotificationTemplate`, `Notification`, `SupervisorEvent`, `SystemSetting`.
- Integrations: `Integration`, `IntegrationStatus`, `ProviderConfig`.
- Worker lifecycle: `WorkerRun`, `WorkerHeartbeat`, `WorkerFailure`.
- Webhooks: `IncomingWebhook`.

### 2.3 Code paths that matter for this evolution

| Concern | File | Notes |
|---|---|---|
| Account snapshots | `apps/worker-execution/src/index.ts` (~L191–L210), `apps/worker-supervisor/src/index.ts`, `apps/gateway/src/index.ts` | Worker-execution writes `AccountSnapshot` keyed by a single resolved `getMt5IntegrationId()` |
| Risk gates | `packages/core/src/execution/decision-engine.ts` | Deterministic. ~399 lines. Pure function. The right primitive to keep — needs a rule-profile input. |
| Candidate generation | `apps/worker-market/src/index.ts` + `packages/core/src/analysis/` | 10-signal-group voting, 60% agreement threshold |
| Validation | `apps/worker-validation/src/index.ts` + `packages/core/src/validation/score.ts` + `packages/core/src/analytics/backtest.ts` | Real analogs by Pearson, MC fallback, finalValidationScore |
| Execution orchestration | `apps/worker-execution/src/index.ts` (~622 lines) | Currently single-path: one candidate → one decision → one order |
| MT5 adapter (TS) | `apps/mt5-adapter/src/index.ts` | Proxies Python bridge; mock fallback when bridge unreachable |
| MT5 bridge (Py) | `integrations/mt5-bridge/main.py` + `mt5_client.py` | FastAPI on Windows; env creds |
| Audit | `apps/api/src/lib/audit.ts`, `apps/api/src/modules/audit/` | Generic, structured; already used everywhere |
| Notifications | `worker-supervisor` consumes `notifications` queue → Discord webhook |
| SSE | `apps/gateway/src/index.ts` | 5s poll; streams three event types |

### 2.4 Single-account assumptions baked into the current code

These are the assumptions we must surgically remove. Every one of these is a compile-time or runtime "one row" shortcut:

1. `AccountSnapshot.integrationId` is optional and the worker reads the **latest row** as "the" account. No notion of "per-account latest".
2. `Order.integrationId` is optional; execution uses a single `getMt5IntegrationId()` helper.
3. `Position` has **no `accountId` or `integrationId` foreign key** — position-to-account mapping is implicit via the related `Order`.
4. `ExecutionDecision` has no `accountId` field — one decision belongs to one candidate, not to an (account, candidate) pair.
5. `worker-execution` queries `prisma.position.findMany({ where: { status: "OPEN" } })` globally — it treats all open positions as one portfolio.
6. `SystemSetting` / env (`DAILY_LOSS_CAP_PCT`, `MAX_ACTIVE_TRADES`, `DRAWDOWN_THRESHOLD_PCT`, `STALE_SIGNAL_SECONDS`) are global, not per-account.
7. `RiskState` on `AccountSnapshot` is per-row but there is no concept of "account mode" (normal, cautious, recovery, payout-protect, locked).
8. `TradingMode {PAPER, LIVE}` is a single-axis mode — no phase (evaluation 1 / evaluation 2 / funded / scale-up / breached / archived).
9. Kill switch is a boolean on the latest snapshot — it cannot currently be "kill account A only".
10. Supervisor schedules one `sync-account` job, not one per account.
11. MT5 bridge `/health` is pinged but nothing currently blocks execution when the bridge is stale — the adapter silently falls back to mock in-memory state, which is dangerous for funded trading.
12. No "account fit" scoring anywhere. A validated candidate directly triggers one execution attempt.
13. No Ollama. No Obsidian. No AI review table. No `LessonLearned`. No `PortfolioExposureSnapshot` across accounts.

### 2.5 What's already great (quiet wins we should build on, not replace)

- **Reason codes** (`DECISION_CODES` in `packages/shared`) are already structured. Every blocker has a code, observed vs. expected, rule string. Perfect feedstock for the LLM critic.
- **Idempotency** is already a first-class concern (`ExecutionDecision.idempotencyKey @unique`, `NewsItem.dedupeHash @unique`, `Order.brokerOrderId @unique`, `Notification.dedupeKey @unique`).
- **Audit trail** (`AuditLog`) is already the backbone of observability. Every new capability should append to it.
- **Structured reasoning log** (`reasoningLog: Json` on `MarketSnapshot`, `TradeCandidate`, `ValidationRun`) is already normalised — we can feed it into the LLM verbatim.
- **Kill-switch plumbing** exists (`api/src/modules/control/`, `SystemSetting` row, `AccountSnapshot.killSwitchActive`) — we only need to make it per-account and add stale-bridge gating.
- **Supervisor repeat jobs** (`sync-account`, `health-check`, `daily-summary`) are the right chassis for new loops (bridge heartbeat, account-phase evaluator, post-trade review, Obsidian export).
- **Decision engine is a pure function** — easy to parameterise by rule profile and account.

This is an **excellent base**. We evolve, we don't rewrite.

---

## 3. Gap analysis

Labels: **REUSE** (keep as-is) · **EXTEND** (additive change to existing code) · **REFACTOR** (must change shape) · **NEW** (add).

### 3.1 Domain model

| Concern | Disposition | Notes |
|---|---|---|
| `Symbol`, `PriceBar`, `MarketSnapshot`, `NewsItem`, `SymbolNewsLink`, `Watchlist*`, `BacktestResult`, `WorkerRun`, `WorkerHeartbeat`, `WorkerFailure`, `IncomingWebhook`, `Integration`, `IntegrationStatus`, `ProviderConfig`, `NotificationTemplate`, `Notification`, `SupervisorEvent`, `SystemSetting`, `User`, `Role`, `UserRole`, `AuditLog` | **REUSE** | No changes needed for multi-account |
| `AccountSnapshot` | **REFACTOR** | Add required `accountId`, keep `integrationId` for lineage; add `phaseId`, `mode`, `trailingHighEquity`, `dailyStartingEquity`, `distanceToDailyDdPct`, `distanceToTotalDdPct` |
| `TradeCandidate` | **EXTEND** | No accountId yet — candidate is account-agnostic. Keep it that way. The fan-out to accounts happens in `SetupAllocation` (new). |
| `ValidationRun` | **REUSE** | Account-agnostic, correct. |
| `ExecutionDecision` | **REFACTOR** | Add `accountId` FK; `idempotencyKey` should include accountId in its hash. One candidate can produce 0..N decisions (one per eligible account). |
| `Order` | **REFACTOR** | Make `accountId` required (keep `integrationId` for broker audit). |
| `Position` | **REFACTOR** | Add required `accountId`. Supervision timestamps (`lastSupervisionAt`, `supervisionState`) for the AI supervisor. |
| `RiskEvent` | **EXTEND** | Add optional `accountId`. Per-account kill switch events. |

### 3.2 Workers and services

| Area | Disposition | Notes |
|---|---|---|
| `worker-news` | **REUSE** | Account-agnostic. |
| `worker-market` | **REUSE** | Candidates remain account-agnostic. |
| `worker-validation` | **REUSE** | Account-agnostic. |
| `worker-execution` | **REFACTOR** | Remove `getMt5IntegrationId()`. Consume validated candidates, call new `SetupAllocationService`, place per account. |
| `worker-supervisor` | **EXTEND** | Add: per-account `sync-account`, bridge-heartbeat loop, kill-stale-bridge check, account-phase evaluator, AI post-trade review scheduler, Obsidian export scheduler. |
| `mt5-adapter` | **EXTEND** | Route by accountId; add `/health/deep` with freshness; refuse writes when bridge stale; command idempotency keys. |
| `mt5-bridge` (Python) | **EXTEND** | Support multi-login (swap login per request) OR operate as a single-account node per Windows terminal (see §9). Add `/health/deep`, heartbeat timestamps, idempotency de-dupe. |
| `packages/core/execution/decision-engine.ts` | **EXTEND (minimal)** | Accept `ruleProfile` and `accountState` as inputs instead of `riskLimits + account`. Existing gates become rule-profile-driven. No logic is deleted. |
| `packages/core/risk/correlation.ts` | **EXTEND** | Cross-account correlation computation. |
| `packages/core/scoring/normalize.ts` | **EXTEND** | Add account-fit scoring primitives. |

### 3.3 Net-new subsystems

| Subsystem | Why |
|---|---|
| **`packages/core/accounts/`** (NEW) | Account registry, phase engine, mode engine, distance-to-breach calculators. |
| **`packages/core/allocation/`** (NEW) | Setup-to-account matching: eligibility, account fit, allocation policies, exclusivity. |
| **`packages/core/portfolio/`** (NEW) | Cross-account exposure aggregator. |
| **`packages/ai/`** (NEW workspace package) | Ollama client, prompt library, JSON-schema-constrained responses, safety guards. |
| **`packages/obsidian/`** (NEW workspace package) | Markdown exporter writing to a watched vault folder. |
| **`apps/worker-supervisor`** extensions | Bridge health loop, AI post-trade reviewer, Obsidian export. |
| **`apps/worker-execution`** extensions | AI pre-trade critic (advisory only), AI position supervisor (advisory only). |
| **API modules** | `accounts`, `phases`, `rule-profiles`, `allocations`, `exposure`, `reviews`, `lessons`. |
| **Web pages** | `/accounts`, `/accounts/[id]`, `/allocations`, `/exposure`, `/reviews`, `/lessons`, `/ai` (explainability console). |
| **Migrations** | See §8 for ordered list. |

### 3.4 Blockers and technical debt to watch

1. `worker-execution` is 622 lines of imperative orchestration with implicit single-account assumptions. Split it into `accountResolver → allocator → decisionRunner → executor → verifier` *before* adding AI, or it will become unmaintainable.
2. `SystemSetting` is used as global config for risk limits. Migrate these into `AccountRuleProfile` and treat `SystemSetting` as genuinely global-only (kill switch, maintenance mode).
3. `AccountSnapshot.integrationId` being optional is a landmine once we have many accounts. Tighten it to required `accountId` and keep `integrationId` optional for broker lineage.
4. `mt5-adapter` silently falling back to mock when the bridge is unreachable is **the single most dangerous behaviour** in the current code for live trading. Must be gated behind an explicit `allowMockFallback` flag and blocked in funded modes.
5. Gateway SSE is a 5s poll against Postgres. Fine for now, but the account-count multiplier will push us toward Redis pub/sub eventually — not a phase-1 blocker.
6. The `reasoningLog` JSON structure is informal in places. Before feeding it to the LLM, normalise the schema (zod in `packages/types`).
7. No tests on `worker-execution/index.ts` today. Refactor must ship with coverage.

### 3.5 What can be reused as-is (just to be explicit)

- All `worker-news` + `packages/core/news/*` + `packages/core/analysis/*` (market scan, indicators, regime detection) + `packages/core/validation/*` + `packages/core/analytics/backtest.ts`.
- Fastify plugin structure under `apps/api/src/modules/*`.
- BullMQ queue factory, SSE gateway structure, Discord notification pipeline.
- All UI plumbing (SWR polling, pages scaffold).
- Docker compose layout (additive only — add optional Ollama profile, add optional obsidian-exporter profile).

---

## 4. Target architecture

### 4.1 Control plane vs. execution plane

```
┌────────────────────────── MAC MINI M4 PRO ──────────────────────────┐
│  CONTROL PLANE (and primary automation host)                        │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ apps/api │  │ gateway  │  │   web    │  │ workers* │  ← Mac      │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘             │
│       │             │              │            │                   │
│       └──────┬──────┴──────────────┴────────────┘                   │
│              │                                                      │
│       ┌──────▼──────┐  ┌────────────┐  ┌────────────┐               │
│       │  postgres   │  │   redis    │  │   ollama   │  ← Mac only   │
│       └─────────────┘  └────────────┘  └────────────┘               │
│                                            ▲                        │
│                                            │ (local HTTP)           │
│                          ┌─────────────────┘                        │
│                          │                                          │
│                   ┌──────┴─────────┐                                │
│                   │ packages/ai    │  local LLM client              │
│                   │ packages/obs   │  obsidian exporter             │
│                   └────────────────┘                                │
│                                                                     │
│   workers* = worker-news, worker-market, worker-validation,         │
│              worker-execution, worker-supervisor                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ LAN (mutual auth, idempotent)
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│  WINDOWS EXECUTION NODE(S)  (one per MT5 terminal / account set)    │
│                                                                     │
│   ┌────────────────────────┐   ┌─────────────────────┐              │
│   │ apps/mt5-adapter       │   │ integrations/       │              │
│   │ (TS proxy, per-account)│←──│ mt5-bridge (Py)     │              │
│   └────────────────────────┘   │  + MetaTrader5 SDK  │              │
│                                └──────────┬──────────┘              │
│                                           │                         │
│                                           ▼                         │
│                                   ┌───────────────┐                 │
│                                   │  MT5 Terminal │                 │
│                                   └───────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 New bounded contexts on the Mac

1. **Account Registry** — identity, phase, rule profile, mode.
2. **Rule Engine** — deterministic hard-rule evaluator (current decision-engine, extended).
3. **Setup Allocator** — picks the best account(s) for a validated candidate.
4. **Portfolio Exposure Monitor** — aggregates across accounts (symbol, cluster, session, event).
5. **AI Pre-Trade Critic** — advisory, LLM, JSON-schema output.
6. **AI Position Supervisor** — advisory, LLM, JSON-schema output.
7. **AI Post-Trade Reviewer** — batch, LLM, writes `TradeReview`.
8. **Lesson Extractor** — batch, LLM, writes `LessonLearned`.
9. **Obsidian Exporter** — idempotent markdown writer.
10. **Bridge Health Watcher** — every 5s, per Windows node.

### 4.3 Execution flow (end-to-end)

```
(1) News ingested              worker-news        → NewsItem, SymbolNewsLink
(2) Market scanned             worker-market      → MarketSnapshot, TradeCandidate
(3) Analog validated           worker-validation  → ValidationRun (PASSED/FAILED)
(4) Account eligibility +      allocator svc      → SetupAllocation (per-account rows)
    account-fit scored
(5) Allocation decision        allocator svc      → SetupAllocation.status = ASSIGNED
(6) AI pre-trade critique      ai svc (advisory)  → AiTradeReview (advise only)
(7) Hard-rule enforcement      decision engine    → ExecutionDecision (per account)
(8) Execution                  worker-execution   → Order via mt5-adapter (per account)
(9) Open-trade supervision     supervisor svc     → AiPositionReview, RiskEvent, actions
(10) Post-trade review         ai svc (batch)     → AiTradeReview (post)
(11) Lesson extraction         ai svc (batch)     → LessonLearned
(12) Obsidian export           exporter svc       → markdown in vault/
```

Invariants:

- Step 7 **cannot** be overridden by step 6. AI is advisory.
- Step 8 **must** verify read-after-write via `/positions` and `/orders` before marking `Order.status = FILLED`.
- Step 9 **can** emit `FULL_CLOSE` / `TIGHTEN_STOP` actions that flow back through a small, deterministic *closing* rule check (never increase risk) before the adapter call.

---

## 5. Domain model changes (Prisma)

All new tables are designed to be additive and backward-compatible. Existing rows keep working until `accountId` backfills complete.

### 5.1 New enums

```prisma
enum AccountPhaseKind {
  EVALUATION_1
  EVALUATION_2
  FUNDED
  PAYOUT_PROTECT
  SCALE_UP
  PAUSED
  BREACHED
  ARCHIVED
}

enum AccountMode {
  NORMAL
  CAUTIOUS
  RECOVERY
  TARGET_NEAR
  PAYOUT_PROTECT
  LOCKED
}

enum AccountHealth {
  HEALTHY
  WATCH
  AT_RISK
  CRITICAL
  BREACHED
}

enum AllocationPolicy {
  ONE_ACCOUNT_ONLY
  MAX_N_ACCOUNTS
  CHALLENGE_ONLY
  FUNDED_ONLY
  BEST_HEALTH_ONLY
  LOWEST_RISK_ONLY
  ROUND_ROBIN
}

enum AllocationStatus {
  PENDING
  ELIGIBLE
  ASSIGNED
  REJECTED
  EXPIRED
  EXECUTED
}

enum SupervisionAction {
  HOLD
  MOVE_STOP
  TIGHTEN_STOP
  PARTIAL_CLOSE
  FULL_CLOSE
  BLOCK_REENTRY
  REVIEW_ONLY
}

enum AiReviewKind {
  PRE_TRADE
  POSITION
  POST_TRADE
  WEEKLY_SYNTHESIS
  ACCOUNT_PHASE
}

enum AiVerdict {
  PROCEED
  PROCEED_WITH_CAUTION
  REDUCE_SIZE
  WAIT
  SKIP
}

enum RuleViolationOutcome {
  PREVENTED
  DETECTED
  BREACHED
}

enum JournalExportStatus {
  PENDING
  WRITTEN
  FAILED
  STALE
}
```

### 5.2 New tables

```prisma
model Account {
  id                String    @id @default(cuid())
  label             String    @unique          // "FTMO-100k-Phase1"
  provider          String                     // "FTMO", "FundedNext", "MyForexFunds"
  accountType       String                     // "challenge", "funded", "personal"
  brokerLogin       String                     // MT5 login number
  integrationId     String                     // link to Integration (MT5 connection)
  baseCurrency      String     @default("USD")
  initialBalance    Float
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt

  currentPhaseId    String?
  currentProfileId  String?
  currentMode       AccountMode @default(NORMAL)
  health            AccountHealth @default(HEALTHY)
  killSwitchLocal   Boolean     @default(false)
  isActive          Boolean     @default(true)

  integration       Integration      @relation(fields: [integrationId], references: [id])
  currentPhase      AccountPhase?    @relation("CurrentPhase", fields: [currentPhaseId], references: [id])
  currentProfile    AccountRuleProfile? @relation("CurrentProfile", fields: [currentProfileId], references: [id])

  phases            AccountPhase[]       @relation("AccountPhases")
  profiles          AccountRuleProfile[] @relation("AccountProfiles")
  dailyMetrics      AccountDailyMetric[]
  snapshots         AccountSnapshot[]
  allocations       SetupAllocation[]
  fitReviews        AccountFitReview[]
  decisions         ExecutionDecision[]
  orders            Order[]
  positions         Position[]
  riskEvents        RiskEvent[]
  aiReviews         AiTradeReview[]
  positionReviews   AiPositionReview[]
  ruleViolations    RuleViolation[]
  lessons           LessonLearned[]

  @@index([isActive, health])
}

model AccountPhase {
  id                 String             @id @default(cuid())
  accountId          String
  kind               AccountPhaseKind
  startedAt          DateTime           @default(now())
  endedAt            DateTime?
  objectives         Json                // {target_profit_pct, max_days, min_trading_days, min_trades}
  metadata           Json?
  resultSummary      String?

  account            Account            @relation("AccountPhases", fields: [accountId], references: [id], onDelete: Cascade)
  currentFor         Account[]          @relation("CurrentPhase")

  @@index([accountId, kind])
  @@index([kind, endedAt])
}

model AccountRuleProfile {
  id                           String   @id @default(cuid())
  accountId                    String
  name                         String
  version                      Int      @default(1)
  isActive                     Boolean  @default(true)

  // Hard prop rules (from the funding firm)
  dailyDrawdownPct             Float
  totalDrawdownPct             Float
  trailingDrawdown             Boolean  @default(false)
  profitTargetPct              Float?

  // Internal (stricter) rules
  internalDailyDdPct           Float
  internalTotalDdPct           Float
  maxRiskPerTradePct           Float
  maxOpenRiskPct               Float
  maxTradesPerDay              Int
  maxConcurrentPositions       Int
  maxSymbolExposurePct         Float
  maxCorrelatedExposurePct     Float
  maxEntrySpreadPct            Float
  staleSignalSeconds           Int

  // Constraints
  allowedAssetClasses          Json     // ["FX", "METAL"] etc.
  blockedSymbols               Json     @default("[]")
  allowedSessions              Json     // ["LONDON", "NY"]
  tradingWindowUtc             Json     // [{ start:"07:00", end:"16:00" }]
  newsBlackoutMinutes          Int      @default(3)
  weekendHoldAllowed           Boolean  @default(false)
  overnightHoldAllowed         Boolean  @default(true)

  createdAt                    DateTime @default(now())
  updatedAt                    DateTime @updatedAt

  account                      Account  @relation("AccountProfiles", fields: [accountId], references: [id], onDelete: Cascade)
  currentFor                   Account[] @relation("CurrentProfile")

  @@index([accountId, isActive])
}

model AccountDailyMetric {
  id                   String   @id @default(cuid())
  accountId            String
  sessionDate          DateTime  // 00:00 UTC anchor for the trading day
  startingEquity       Float
  endingEquity         Float?
  highEquity           Float
  lowEquity            Float
  realizedPnl          Float    @default(0)
  openPnlAtClose       Float    @default(0)
  maxDrawdownPct       Float    @default(0)
  tradesCount          Int      @default(0)
  winsCount            Int      @default(0)
  lossesCount          Int      @default(0)
  notes                Json?

  account              Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  @@unique([accountId, sessionDate])
  @@index([accountId, sessionDate])
}

model AccountFitReview {
  id                String       @id @default(cuid())
  accountId         String
  candidateId       String
  fitScore          Float         // 0-100
  fitReasons        Json
  rejectionReasons  Json
  ruleProfileId     String
  computedAt        DateTime     @default(now())

  account           Account         @relation(fields: [accountId], references: [id], onDelete: Cascade)
  candidate         TradeCandidate  @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  @@unique([candidateId, accountId])
  @@index([candidateId])
}

model SetupAllocation {
  id                String            @id @default(cuid())
  candidateId       String
  accountId         String?            // null until assigned
  policy            AllocationPolicy
  status            AllocationStatus  @default(PENDING)
  fitScore          Float?
  reasoning         Json
  decidedAt         DateTime          @default(now())
  expiresAt         DateTime?
  decisionId        String?           @unique

  candidate         TradeCandidate     @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  account           Account?           @relation(fields: [accountId], references: [id], onDelete: SetNull)
  decision          ExecutionDecision? @relation(fields: [decisionId], references: [id], onDelete: SetNull)

  @@index([candidateId, status])
  @@index([accountId, status])
}

model PortfolioExposureSnapshot {
  id                    String   @id @default(cuid())
  capturedAt            DateTime @default(now())
  byAccount             Json     // [{ accountId, equity, openRiskPct, positionsCount }]
  bySymbol              Json     // [{ symbol, totalQty, totalExposurePct }]
  byCorrelationGroup    Json     // [{ group, totalExposurePct }]
  bySession             Json     // [{ session, totalExposurePct }]
  notes                 Json?

  @@index([capturedAt])
}

model AiTradeReview {
  id                String       @id @default(cuid())
  kind              AiReviewKind
  accountId         String?
  candidateId       String?
  decisionId        String?
  positionId        String?
  modelName         String
  promptVersion     String
  verdict           AiVerdict?
  strengths         Json
  weaknesses        Json
  contradictions    Json
  riskContext       Json
  recommendation    String
  rawResponse       Json
  latencyMs         Int
  costTokens        Int?
  createdAt         DateTime     @default(now())

  account           Account?        @relation(fields: [accountId], references: [id], onDelete: SetNull)
  candidate         TradeCandidate? @relation(fields: [candidateId], references: [id], onDelete: SetNull)
  decision          ExecutionDecision? @relation(fields: [decisionId], references: [id], onDelete: SetNull)
  position          Position?       @relation(fields: [positionId], references: [id], onDelete: SetNull)

  @@index([kind, createdAt])
  @@index([accountId, createdAt])
}

model AiPositionReview {
  id                 String              @id @default(cuid())
  positionId         String
  accountId          String
  modelName          String
  promptVersion      String
  action             SupervisionAction
  confidence         Float
  reasoning          Json
  observedEvidence   Json                // thesis weakening, stall, event risk, etc.
  outcomeApplied     Boolean             @default(false)
  outcomeNotes       String?
  createdAt          DateTime            @default(now())

  position           Position            @relation(fields: [positionId], references: [id], onDelete: Cascade)
  account            Account             @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@index([positionId, createdAt])
  @@index([accountId, createdAt])
}

model RuleViolation {
  id               String                 @id @default(cuid())
  accountId        String
  ruleProfileId    String
  ruleKey          String                  // "daily_drawdown_pct"
  outcome          RuleViolationOutcome    // PREVENTED | DETECTED | BREACHED
  severity         Severity
  observedValue    Float?
  thresholdValue   Float?
  evidence         Json
  occurredAt       DateTime                @default(now())
  resolvedAt       DateTime?

  account          Account                 @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@index([accountId, occurredAt])
  @@index([outcome, severity])
}

model LessonLearned {
  id            String       @id @default(cuid())
  scope         String       // "account" | "symbol" | "strategy" | "regime" | "global"
  scopeKey      String
  accountId     String?
  summary       String
  evidence      Json          // trades, reviews, snapshots
  tags          Json
  priority      Int           @default(50)
  source        String        // "post_trade" | "weekly_synthesis" | "manual"
  createdAt     DateTime      @default(now())
  supersededAt  DateTime?

  account       Account?      @relation(fields: [accountId], references: [id], onDelete: SetNull)

  @@index([scope, scopeKey])
  @@index([accountId, supersededAt])
}

model JournalExport {
  id            String              @id @default(cuid())
  kind          String               // "trade" | "account_daily" | "weekly" | "lesson"
  entityType    String
  entityId      String
  status        JournalExportStatus  @default(PENDING)
  filePath      String
  checksum      String?
  attemptCount  Int                  @default(0)
  lastAttemptAt DateTime?
  writtenAt     DateTime?
  errorMessage  String?

  @@unique([entityType, entityId, kind])
  @@index([status])
}

model BridgeHealthSnapshot {
  id                String   @id @default(cuid())
  nodeId            String    // windows node label
  integrationId     String
  reachable         Boolean
  latencyMs         Int?
  terminalConnected Boolean
  accountsReported  Json       // [{ login, balance, equity }]
  lastSuccessfulAt  DateTime?
  payload           Json?
  capturedAt        DateTime @default(now())
  @@index([nodeId, capturedAt])
}
```

### 5.3 Refactor-in-place changes

```prisma
model AccountSnapshot {
  // existing fields kept.
  accountId             String
  phaseId               String?
  mode                  AccountMode    @default(NORMAL)
  trailingHighEquity    Float?
  dailyStartingEquity   Float?
  distanceToDailyDdPct  Float?
  distanceToTotalDdPct  Float?

  account               Account       @relation(fields: [accountId], references: [id], onDelete: Cascade)
  phase                 AccountPhase? @relation(fields: [phaseId], references: [id], onDelete: SetNull)

  @@index([accountId, capturedAt])
}

model ExecutionDecision {
  // existing fields kept.
  accountId             String?        // null only for dry-run/simulation
  allocationId          String?        @unique
  account               Account?       @relation(fields: [accountId], references: [id], onDelete: SetNull)
  allocation            SetupAllocation? @relation
}

model Order {
  accountId             String
  account               Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  commandIdempotencyKey String  @unique
}

model Position {
  accountId             String
  account               Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  lastSupervisionAt     DateTime?
  supervisionState      SupervisionAction @default(HOLD)
  thesisHash            String?
  aiReviews             AiPositionReview[]
  @@index([accountId, status])
}

model RiskEvent {
  accountId             String?
  account               Account? @relation(fields: [accountId], references: [id], onDelete: SetNull)
  @@index([accountId, createdAt])
}
```

### 5.4 Migration plan

1. `20260425_add_account_core` — creates `Account`, `AccountPhase`, `AccountRuleProfile`, `AccountDailyMetric`, new enums. Adds nullable `accountId` to `AccountSnapshot`, `ExecutionDecision`, `Order`, `Position`, `RiskEvent`.
2. `20260426_backfill_default_account` — seeds a single `Account` row for the current MT5 integration, backfills `accountId` on existing rows.
3. `20260427_enforce_account_not_null` — flips `accountId` to required on `Order`, `Position`, `AccountSnapshot`.
4. `20260428_add_allocation_and_fit` — creates `SetupAllocation`, `AccountFitReview`, `PortfolioExposureSnapshot`.
5. `20260429_add_ai_and_journal` — creates `AiTradeReview`, `AiPositionReview`, `RuleViolation`, `LessonLearned`, `JournalExport`, `BridgeHealthSnapshot`.

Each migration is additive and reversible except #3, which has a guarded up-step.

---

## 6. New TypeScript types (zod in `packages/types`)

New schema modules (each a file in `packages/types/src/`):

- `accounts.ts` — `AccountSchema`, `AccountPhaseSchema`, `AccountRuleProfileSchema`, `AccountHealthSchema`, `AccountModeSchema`, `AccountDailyMetricSchema`.
- `allocation.ts` — `SetupAllocationSchema`, `AllocationPolicySchema`, `AccountFitSchema`, `AllocationDecisionSchema`.
- `exposure.ts` — `PortfolioExposureSchema`, `ByAccountExposureSchema`, `BySymbolExposureSchema`.
- `supervision.ts` — `SupervisionActionSchema`, `AiPositionReviewSchema`.
- `ai.ts` — `AiReviewKindSchema`, `AiTradeReviewSchema`, `AiVerdictSchema`, `PreTradeCritiqueSchema`, `PostTradeReviewSchema`, `LessonSchema`.
- `bridge.ts` — `BridgeHealthSchema`, `BridgeCommandSchema`, `BridgeOrderRequestSchema` (accountId-scoped, idempotency-keyed).
- `journal.ts` — `JournalExportSchema`.

All LLM outputs are validated with zod before being persisted. Reject and log on schema mismatch; never trust model output blindly.

---

## 7. Service / module design

### 7.1 `packages/core/accounts/`

- `registry.ts` — `listActiveAccounts()`, `getAccountWithProfile(id)`, cache-backed.
- `phases.ts` — `computePhaseProgress(account, snapshots)`, `shouldAdvancePhase`, `markPhaseBreached`.
- `modes.ts` — `computeAccountMode({profile, snapshot, dailyMetric})`. Deterministic state machine:
  - `LOCKED` if phase is PAUSED/BREACHED/ARCHIVED
  - `PAYOUT_PROTECT` if near payout and funded phase
  - `RECOVERY` if drawdown >= 50% of internal daily cap
  - `CAUTIOUS` if drawdown >= 30% of internal daily cap OR 2 consecutive losses today
  - `TARGET_NEAR` if profit target >= 80% hit
  - else `NORMAL`
- `health.ts` — `computeAccountHealth({snapshot, profile})`: HEALTHY / WATCH / AT_RISK / CRITICAL / BREACHED based on distance-to-breach bands (>50% / 25–50% / 10–25% / <10% / negative).
- `distance.ts` — `distanceToDailyDdPct`, `distanceToTotalDdPct`.

### 7.2 `packages/core/allocation/`

- `eligibility.ts` — for each active account, apply rule-profile filters to candidate (asset class allowed, symbol not blocked, session window, news blackout, weekend hold flag).
- `fit-score.ts` — 0..100 per account. Composable scorer:
  - Health bonus (HEALTHY +30, WATCH +15, AT_RISK 0, CRITICAL −100)
  - Mode bonus (NORMAL +20, CAUTIOUS +5, RECOVERY −40, TARGET_NEAR +10, PAYOUT_PROTECT −60, LOCKED −∞)
  - Phase bonus (funded +25, eval-phase-1 +15 for high-edge setups only, scale-up +10)
  - Drawdown room (linear, 0..25)
  - Daily trades used (penalty 0..−25)
  - Strategy-affinity (per-profile allowlist)
  - Recent losers on same symbol in this account (−0..−25)
  - Cross-account correlation penalty (−0..−30)
  - Result: `{fitScore, reasons: DecisionRecord[], rejectionReasons: DecisionRecord[]}`.
- `policies.ts` — policy resolvers:
  - `ONE_ACCOUNT_ONLY` → take top-1 by fit score
  - `MAX_N_ACCOUNTS` → top-N, each still subject to rule profile
  - `CHALLENGE_ONLY` / `FUNDED_ONLY` → filter by accountType
  - `BEST_HEALTH_ONLY` / `LOWEST_RISK_ONLY` → tiebreakers
  - `ROUND_ROBIN` → state-backed, uses `SystemSetting` row
- `allocate.ts` — orchestrates: eligibility → fit → policy → `SetupAllocation` rows. Writes `AccountFitReview` for every (candidate, eligible account) pair for explainability.

### 7.3 `packages/core/portfolio/`

- `exposure.ts` — `computePortfolioExposure(accounts, positions)` → `PortfolioExposureSnapshot`.
- `clusters.ts` — currency cluster for FX (USD cluster, EUR cluster, metal cluster), correlation groups reused from `Symbol.correlationGroup`.
- `session.ts` — session attribution for currently-open positions.
- `guard.ts` — `wouldViolatePortfolioCaps({candidate, account, currentExposure, profile})`.

### 7.4 `packages/ai/` (NEW workspace package)

Dependencies: `ollama` JS client (or plain `fetch` to `http://localhost:11434`), `zod`, `@stock-radar/logging`, `@stock-radar/types`.

Files:

- `client.ts` — `OllamaClient`: `generateJson<TSchema>({model, system, prompt, schema})`. Forces `format: "json"`, retries on schema violation, tracks latency + tokens.
- `models.ts` — `getDefaultModel()` (env: `OLLAMA_MODEL`, default `llama3.1:8b-instruct`), model registry with per-task overrides.
- `prompts/pretrade.ts` — system + user prompt templates. Inputs: candidate, validation, news context, account snapshot, rule profile, open positions. Output schema: `PreTradeCritiqueSchema` (verdict, strengths, weaknesses, contradictions, risk context, recommendation, confidence).
- `prompts/position.ts` — inputs: position, current quote, recent bars, account snapshot, news context, time in trade. Output: `SupervisionAction`-shaped result.
- `prompts/posttrade.ts` — inputs: closed position, entry rationale, outcome. Output: structured review.
- `prompts/weekly.ts` — weekly synthesis over post-trade reviews for an account.
- `prompts/nlq.ts` — natural-language analytics queries against structured retrieval results (see §13).
- `safety.ts` — never-suggest filter: refuses to emit actions that remove stops, increase size, bypass kill switch, or trade blocked symbols.
- `cache.ts` — content-hashed caching keyed by prompt version.

Constraints applied to every call:

- `format: json`
- `options: { temperature: 0.2 }` for critique/review; `0.0` for any action-producing call.
- Hard timeout 6s pre-trade, 4s position supervision (the position loop must not block MT5 writes).
- Circuit breaker: if 3 consecutive failures, mark the AI subsystem degraded and the flow continues without AI.

### 7.5 `packages/obsidian/`

- `vault.ts` — reads `OBSIDIAN_VAULT_PATH`; validates path safety (must be under the configured root).
- `templates/` — handlebars templates:
  - `trade.md` — per closed trade, includes the full rationale, validation metrics, AI pre/post reviews, outcome, and lesson.
  - `daily.md` — per account per day (balance, P&L, violations, mode transitions).
  - `weekly.md` — per account per week (synthesis, top winners, repeat losers).
  - `lesson.md` — one per `LessonLearned`.
- `writer.ts` — atomic write, checksum-aware, updates `JournalExport` row. Idempotent: re-running a day never produces duplicate files.
- `export-queue.ts` — BullMQ job `journal-export` keyed by entity.

### 7.6 Execution worker refactor (`apps/worker-execution`)

Split the 622-line `src/index.ts` into:

- `src/index.ts` — thin BullMQ consumer.
- `src/flow/collect-context.ts` — load candidate + validation + current positions + market context.
- `src/flow/allocate.ts` — call `allocation` service; return 0..N `{account, allocation, fitReview}` tuples.
- `src/flow/pretrade-critic.ts` — AI call, advisory, non-blocking, records `AiTradeReview`.
- `src/flow/decide.ts` — calls `makeExecutionDecision(context, account, profile)` per allocation.
- `src/flow/place.ts` — calls the account's mt5-adapter, idempotent command key, read-after-write verification.
- `src/flow/record.ts` — writes `Order`, `Position` (on fill), `RiskEvent` rows.
- `src/safety/bridge-gate.ts` — refuses to place when `BridgeHealthSnapshot` for that account is stale (>10s) or terminal is disconnected.

### 7.7 Supervisor worker extensions (`apps/worker-supervisor`)

New repeat jobs:

- `sync-accounts` — every 20s, per active account, pull from that account's mt5-adapter, write `AccountSnapshot` + `AccountDailyMetric` rollup.
- `bridge-heartbeat` — every 5s per Windows node, write `BridgeHealthSnapshot`.
- `position-supervisor` — every 15s over open positions: fresh quote, compute age + drawdown, call AI position supervisor (rate-limited), then apply a deterministic closing-rule filter, then execute through the adapter.
- `account-phase-evaluator` — every 60s, check phase progress, trigger phase transitions (funded → payout-protect, eval → funded, eval → breached).
- `portfolio-exposure-snapshot` — every 30s.
- `post-trade-reviewer` — every 60s, batch closed-since-last-run positions, call AI post-trade reviewer.
- `weekly-synthesis` — Sunday 22:00 UTC per account.
- `journal-export-sweeper` — every 5 minutes, catch-up for pending exports.

### 7.8 MT5 adapter (`apps/mt5-adapter`) changes

- Endpoints now scoped per account: `GET /accounts/:id/account`, `GET /accounts/:id/positions`, `POST /accounts/:id/orders`, `POST /accounts/:id/positions/:positionId/close`, `GET /accounts/:id/health/deep`.
- Route-level idempotency: every `POST` accepts an `X-Command-Id` header, dedupes against a local LRU cache + Postgres `Order.commandIdempotencyKey`.
- Mock fallback is **off by default** in production env and can only be enabled per-account via `ALLOW_MOCK_FALLBACK=true`. In funded mode it is ignored.
- Deep health endpoint reports: `{reachable, terminalConnected, loginMatches, latencyMs, tradeServerTime, lastError}`.

### 7.9 MT5 bridge (`integrations/mt5-bridge`) changes

Two supported modes:

- **Single-login-per-process (recommended to start).** One Windows terminal = one account = one bridge process. Simpler, safer, matches how MT5 actually works. The mt5-adapter route-maps accountId → bridge URL.
- **Future: multi-login** (Py helper that swaps `mt5.login()` per request + per-account locks). Implemented behind a feature flag, **not** part of the initial rollout.

Additive endpoints on the bridge:

- `GET /health/deep` — includes `loginNumber`, `server`, `terminalConnected`, `lastTickTime`, `tradeAllowed`.
- `POST /orders` accepts `commandId` and returns a deterministic 409 with the original response if seen before.
- `POST /positions/:id/close` same idempotency protocol.

---

## 8. API, UI, and config changes

### 8.1 New API modules

Under `apps/api/src/modules/`:

- `accounts/` — CRUD + phase transitions + mode overrides (audited).
- `phases/` — history, progress, objectives.
- `rule-profiles/` — versioned profiles, diff view, activate/deactivate.
- `allocations/` — list + explain (why assigned / why rejected).
- `exposure/` — current + historical snapshots.
- `reviews/` — AI trade reviews and position reviews with filters.
- `lessons/` — lessons learned with scope filters.
- `bridge/` — bridge health stream.

All new modules follow the existing plugin pattern and write `AuditLog` rows.

### 8.2 New UI pages (Next.js under `apps/web/src/app/`)

- `/accounts` — grid of accounts with health/phase/mode badges, distance-to-breach bars, open P&L.
- `/accounts/[id]` — phase progress, current rule profile, daily metrics chart, open positions, allocation history.
- `/allocations` — allocation decisions stream; click any candidate to see fit scores per account.
- `/exposure` — portfolio exposure (by symbol / cluster / session) with per-account breakdown.
- `/reviews` — AI trade reviews (pre and post) with filters (account, symbol, verdict).
- `/lessons` — lessons learned, sortable by priority, searchable by scope.
- `/ai` — AI health, last N calls, latency, error rate, model version.
- `/bridge` — Windows node health timeline, stale-bridge alerts.

Existing pages extended:

- `/` (dashboard) — account cards with phase progress, system health banner that goes red on stale bridge.
- `/execution` — add per-account filter, allocation column.
- `/portfolio` — per-account toggle, cluster view.

### 8.3 Env additions (`.env.local`)

```
# AI
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b-instruct
OLLAMA_PRE_TRADE_MODEL=llama3.1:8b-instruct
OLLAMA_POSITION_MODEL=llama3.1:8b-instruct
OLLAMA_POST_TRADE_MODEL=llama3.1:8b-instruct
AI_TIMEOUT_MS_PRETRADE=6000
AI_TIMEOUT_MS_POSITION=4000
AI_ENABLED=true

# Obsidian
OBSIDIAN_ENABLED=true
OBSIDIAN_VAULT_PATH=/Users/ekjot/Obsidian/TradingVault
OBSIDIAN_EXPORT_CATEGORIES=trade,daily,weekly,lesson

# Bridges (multi-node)
MT5_BRIDGE_NODES=[{"id":"win-1","url":"http://192.168.1.42:8000","integrationId":"int_ftmo_1"}]
BRIDGE_HEARTBEAT_MS=5000
BRIDGE_STALE_MS=15000
BRIDGE_BLOCK_ON_STALE=true
BRIDGE_ALLOW_MOCK_FALLBACK=false

# Per-account kill switches use SystemSetting rows, not env.
```

---

## 9. Ollama integration design (full detail)

Runtime model: Ollama runs on the Mac Mini at `localhost:11434`. The `packages/ai` package is the only code allowed to call it. Every other subsystem uses the package's typed client.

Prompt engineering conventions:

- **All system prompts are terse and literal.** No "you are a helpful assistant". Every prompt begins with: *"You are the AI critic component of a funded-trading system. You are never permitted to recommend removing stops, increasing size, or ignoring kill switches. You always respond with valid JSON matching the given schema."*
- **All user prompts carry a `contextVersion` and `promptVersion`.** Stored on every `AiTradeReview` row for reproducibility.
- **Inputs are compact JSON.** We omit raw bars; we include indicator summaries and reasoning-log digest.
- **Outputs are schema-validated twice:** JSON parse + zod. Failed validation = fallback to `PROCEED_WITH_CAUTION` / `HOLD` with a RiskEvent logged.

Pre-trade critic prompt input (abridged):

```json
{
  "candidate": { "symbol":"XAUUSD", "direction":"LONG", "timeframe":"15m",
                 "setupScore":72, "confidenceScore":68, "strategy":"breakout" },
  "validation": { "winRate":0.58, "expectancy":0.42, "maxDrawdown":8.4,
                  "sampleSize":34, "finalValidationScore":74 },
  "account":    { "phase":"FUNDED", "mode":"NORMAL", "health":"HEALTHY",
                  "distanceToDailyDdPct":4.1, "distanceToTotalDdPct":7.6 },
  "portfolio":  { "openPositions":2, "symbolExposurePct":1.2,
                  "correlatedExposurePct":2.4 },
  "news":       [ { "headline":"…","urgency":"MEDIUM","direction":"BULLISH" } ],
  "reasoningLog": [ {"title":"…","detail":"…"}, … ],
  "ruleProfile":{ "maxRiskPerTradePct":0.4, "maxOpenRiskPct":1.5 }
}
```

Output schema:

```json
{
  "verdict": "PROCEED|PROCEED_WITH_CAUTION|REDUCE_SIZE|WAIT|SKIP",
  "confidence": 0.0-1.0,
  "strengths": ["…"],
  "weaknesses": ["…"],
  "contradictions": ["…"],
  "riskContext": { "eventRisk":"low|med|high", "regimeFit":"strong|mixed|weak" },
  "recommendation": "short sentence, human readable",
  "suggestedSizeMultiplier": 0.0-1.0
}
```

Safety enforcement (`packages/ai/safety.ts`) applied after parse:

- `suggestedSizeMultiplier` clamped to `[0, 1]` — AI can only reduce, never increase.
- `verdict === SKIP` or `WAIT` → advisory only, does not override an *approved* decision, but does surface a RiskEvent of severity WARNING.
- Any mention of removing stops in recommendation text → redact and log.

Position supervisor specifics:

- Max one AI call per position per 60s.
- Actions are narrowed to {`HOLD`, `TIGHTEN_STOP`, `PARTIAL_CLOSE`, `FULL_CLOSE`, `REVIEW_ONLY`}. The adapter refuses `MOVE_STOP` without a concrete price, and refuses a `TIGHTEN_STOP` that is *wider* than the current stop.
- All actions go through `packages/core/accounts/closing-guard.ts` which verifies they only reduce risk.

Fallback if Ollama unavailable:

- Pre-trade: skip AI review (advisory layer disabled); execution proceeds on deterministic rules.
- Position: default to `HOLD` + passive time-based tighten (if time in trade > 2× expected hold, tighten stop by 25% toward entry).
- Post-trade/weekly: queue jobs, retry on next interval.

Health metric: `ai.p50_latency_ms`, `ai.p95_latency_ms`, `ai.failure_rate_5m`. If `failure_rate_5m > 20%`, flip the circuit open for 5 minutes.

---

## 10. MT5 / Windows node hardening

1. **Authenticated LAN.** The adapter ↔ bridge transport requires a shared secret token (`BRIDGE_AUTH_TOKEN`) in an `Authorization: Bearer` header. The bridge refuses unauthenticated requests. We do not expose the bridge publicly.
2. **Heartbeat loop.** `bridge-heartbeat` job writes `BridgeHealthSnapshot` every 5s. If `BRIDGE_BLOCK_ON_STALE=true` (the default), a snapshot older than `BRIDGE_STALE_MS` causes:
   - `BridgeGate.allowsWrite()` → false for that integration
   - `worker-execution` skips the allocation entry for that account
   - A CRITICAL `RiskEvent` is recorded
   - Discord alert fires (deduped per 5 min)
3. **Command idempotency.** Every `POST /orders` and `POST /positions/:id/close` must include `X-Command-Id`. Server persists `(commandId → response)` for 24h.
4. **Read-after-write verification.** After a place call:
   1. Call returns `brokerOrderId`.
   2. Within 1s, call `GET /orders` and `GET /positions` and confirm presence.
   3. Only then mark the local `Order.status = SUBMITTED/FILLED`. If not present within 2s, mark `PENDING_VERIFY` and emit RiskEvent.
5. **Graceful degraded mode.** If a Windows node goes offline:
   - New allocations to that node's accounts are refused.
   - Existing positions continue to be tracked via last-known state.
   - Position supervisor continues running but cannot execute; it records AI recommendations and `RuleViolation(outcome=DETECTED)`.
   - Alerts escalate at 5m, 15m, 30m.
6. **Mock fallback is off by default.** `apps/mt5-adapter` must fail loudly, not silently. A config flag `ALLOW_MOCK_FALLBACK` exists only for paper-trading and is refused for any account in `FUNDED` phase.
7. **Multi-terminal strategy.** Each Windows MT5 terminal = one bridge process = one account (initial rollout). We support multiple Windows nodes from the Mac by configuring `MT5_BRIDGE_NODES` as a list. The `mt5-adapter` becomes a router.

---

## 11. Obsidian export design

Principles: idempotent, append-only in spirit (but safe to regenerate), Postgres is source of truth — Obsidian is derived.

Vault layout:

```
/<vault>/StocksScalper/
  /accounts/
    <account-label>/
      overview.md
      /daily/
        2026-04-22.md
      /weekly/
        2026-W17.md
      /trades/
        2026-04-22_XAUUSD_L_<positionId>.md
  /lessons/
    <scope>/<scopeKey>.md
  /playbooks/   (human-authored, not overwritten)
  /audit/
    risk-violations.md  (append-only)
```

Rules:

- The exporter is the *only* writer in `/StocksScalper/` — any manual edits there will be overwritten on regenerate.
- `/playbooks/` is never touched and is where the operator's living strategy notes live.
- Every export writes a `JournalExport` row with `checksum` of the rendered markdown so regenerate is a no-op when unchanged.
- Templates are in `packages/obsidian/templates/` and are versioned with `promptVersion`-style keys.
- Atomic write: write to `.tmp`, fsync, rename. Never partial.

---

## 12. Safety, rules engine, and fallbacks

The deterministic rule engine (`packages/core/execution/decision-engine.ts`, extended) is the single authority for placement. It takes `{candidate, validation, accountSnapshot, ruleProfile, openPositionsOnThisAccount, portfolioExposure, marketContext}` and returns `StructuredDecision`.

Hard rules (ordered, any blocker stops placement):

1. Per-account kill switch (local) or global kill switch (system).
2. Stale bridge for this account's node.
3. Phase lock (PAUSED / BREACHED / ARCHIVED).
4. Daily drawdown breach against the *tighter of* prop or internal.
5. Total drawdown breach against the tighter of prop or internal.
6. Trailing drawdown breach (if enabled on the profile).
7. Profile caps (maxTradesPerDay, maxConcurrentPositions on this account).
8. Per-symbol exposure cap on this account.
9. Cross-account correlation / cluster cap (portfolio-wide).
10. Session window + news blackout + weekend-hold rules.
11. Spread cap, stale signal cap.
12. Validation score threshold (per-profile).

AI critic outputs `SKIP` / `WAIT` → emits a RiskEvent and (optionally, if `AI_BLOCK_ENABLED=true`, default false) blocks. Default behaviour: advisory only.

Kill switches:

- **Global kill switch** (SystemSetting) — blocks everything.
- **Per-account kill switch** (`Account.killSwitchLocal`) — blocks this account only.
- **Per-symbol trading halt** (from marketContext) — blocks that symbol everywhere.
- **Stale bridge gate** (BridgeHealthSnapshot age > `BRIDGE_STALE_MS`) — blocks that node's accounts.

Degraded-mode matrix:

| Subsystem down | Placement allowed? | Supervision allowed? | Data loss? |
|---|---|---|---|
| Ollama | Yes (no critic) | Yes, fallback HOLD | No |
| Obsidian | Yes | Yes | No (export queue retries) |
| A Windows bridge | No (for that node) | Track-only | No |
| Postgres | No (everything halts) | No | Possible — avoid |
| Redis | No (queues halt) | No | Minimal — workers resume |

---

## 13. Natural-language retrieval over local data

We do **not** do vector-DB-style RAG over raw logs. We do *structured retrieval*: the user's question is parsed by the LLM into a typed query against Postgres (via a small typed query DSL), results are returned, and a second LLM call summarises. This keeps us grounded and reproducible.

Flow:

1. `POST /api/ai/ask` with a natural-language question.
2. Server: LLM with strict schema → `{intent, filters, groupBy, timeRange}`.
3. Execute against Postgres (read-only role) using prepared queries.
4. LLM summarises the result table in natural language with an explicit source list.
5. Persist as `AiTradeReview` kind `WEEKLY_SYNTHESIS` when applicable.

Sample intents the DSL supports:

- `losers_by_phase(phase, window)` → "What failed most in phase 1?"
- `setup_performance(symbol, regime)` → "Which setups on gold perform worst during high volatility?"
- `exit_timing(account, window)` → "Did early exits improve outcomes last month?"

No hallucinated analytics — if the intent parser can't map the question, we return "not supported yet" rather than guessing.

---

## 14. Phased implementation roadmap

Each phase is shaped as a sequence of PRs. Every phase keeps the repo runnable and paper-safe. Live trading remains blocked until Phase G sign-off.

### Phase A — Foundations (week 1)

- A1. Write this file (done).
- A2. Add `packages/types/src/accounts.ts`, `allocation.ts`, `exposure.ts`, `supervision.ts`, `ai.ts`, `bridge.ts`, `journal.ts` (zod + inferred types).
- A3. Add new enums in `schema.prisma`; migration `20260425_add_account_core` with nullable `accountId` on existing tables.
- A4. Add `packages/core/accounts/` with registry, modes, health, distance — all unit-tested.
- A5. Seed script: creates one `Account` from current MT5 integration (derived from `ProviderConfig`), one default `AccountRuleProfile`, phase `FUNDED` by default. Backfill `accountId` on existing `AccountSnapshot`, `Order`, `Position`, `RiskEvent` (`20260426_backfill_default_account`).
- A6. Flip `accountId` to required on `AccountSnapshot`, `Order`, `Position` (`20260427_enforce_account_not_null`). CI green.
- A7. Add `/api/accounts` read endpoints and `/accounts` UI page.

Exit criteria: old behaviour identical, one `Account` visible in UI, schema multi-account-ready.

### Phase B — Rule engine multi-account (week 2) — **COMPLETE**

- B1. ✅ Kept `makeExecutionDecision` signature stable; introduced `buildRiskLimitsFromRuleProfile` adapter (`packages/core/src/accounts/rule-profile-adapter.ts`) that converts an `AccountRuleProfile` + `AccountMode` into the legacy `riskLimits` shape. Mode multiplier is applied to `dynamicRiskPerTradePct` so CAUTIOUS/RECOVERY accounts automatically size down without a second rule-profile version. 5 unit tests.
- B2. ✅ Default `AccountRuleProfile` seeded with the same values that were in env (`DAILY_LOSS_CAP_PCT=5%`, `MAX_ACTIVE_TRADES=3`, `RISK_PER_TRADE_PCT=0.75%`, min R:R=1.5). Env still serves as the fallback seed via `DEFAULT_ACCOUNT_STARTING_BALANCE`.
- B3. ✅ Split `apps/worker-execution/src/index.ts` into flow modules:
  - `flow/types.ts` — shared `AccountContext`, `CandidateContext`, `PipelineDecision` types
  - `flow/collect-context.ts` — fetch active accounts + rule profiles + snapshots + open positions + bridge health
  - `flow/allocate.ts` — run `evaluateCandidateAgainstAccount` per (candidate, account) pair; classifies each row as OK/BLOCK/DEGRADE
  - `flow/pretrade-critic.ts` — Phase-B stub (returns ABSTAIN); Phase E wires Ollama
  - `flow/decide.ts` — call `makeExecutionDecision` with account-derived limits + apply AI reduce multiplier clamped to [0,1]
  - `flow/place.ts` — POST to MT5 adapter with `X-Command-Id`/`X-Account-Id` headers for idempotency
  - `flow/record.ts` — persist `ExecutionDecision`, `Order`, `Position`, `RiskEvent`, `AuditLog` (rollup + per-blocker), `RuleViolation`, `AllocationDecision` — all attributed to `accountId`
  - `flow/market-context.ts` — extracted spread/correlation helpers
  - `safety/bridge-gate.ts` — worker-side wrapper that fetches the latest `BridgeHealthSnapshot` and calls the core `evaluateBridgeGate`
  - `legacy-loop.ts` — preserves the pre-Phase-B single-account path as fallback when no `Account` rows exist; ensures the transition deploy is safe
- B4. ✅ Added:
  - `packages/core/src/accounts/rule-profile-adapter.test.ts` — 5 tests (NORMAL/CAUTIOUS/RECOVERY/LOCKED multiplier behaviour + manualApproval passthrough)
  - `packages/core/src/safety/bridge-gate.test.ts` — 7 tests (no-snapshot, fresh, stale heartbeat, very-stale, terminal-disconnected, DEGRADED ping, ERROR)

Exit criteria met: 54/54 unit tests pass in `@stock-radar/core`. `worker-execution` typechecks with zero real errors (remaining module-resolution errors resolve after `prisma generate` is run with the Phase-A migration applied). Multi-account pipeline is end-to-end: for each validated candidate, every active account is scored deterministically, the highest-priority eligible account is selected, and a full audit trail (ExecutionDecision, Order, Position, RiskEvent, RuleViolation, AuditLog, AllocationDecision) is persisted. Legacy single-account loop is preserved as a safety fallback.

Key invariants locked in:
- AI critic can only REDUCE size: `reduceSizeMultiplier` is clamped to `[0, 1.0]` in `decide.ts`.
- Bridge-gate runs BEFORE rule evaluation; a stale bridge records `ACCOUNT_BRIDGE_STALE` and blocks the account.
- Mode multiplier runs BEFORE the AI reduction, so both stack multiplicatively.
- Mode `LOCKED` yields `dynamicRiskPerTradePct=0`, which causes the decision engine to size to the 0.01-lot floor — but the rule evaluator returns `ACCOUNT_MODE_LOCKED` first and blocks the trade, so this is defense-in-depth.

### Phase C — Allocation and fit (week 3)

- C1. Migration `20260428_add_allocation_and_fit` (`SetupAllocation`, `AccountFitReview`, `PortfolioExposureSnapshot`).
- C2. Build `packages/core/allocation/` with eligibility, fit-score, policies, allocate. Tests.
- C3. Integrate into `worker-execution/flow/allocate.ts`. Validated candidates produce 0..N allocations → 0..N decisions.
- C4. `api/src/modules/allocations` + `/allocations` UI page; `exposure` module + `/exposure` UI page.
- C5. `worker-supervisor` repeat job `portfolio-exposure-snapshot`.

Exit criteria: the same setup can be assigned to account A and skipped for account B with a visible, explainable fit-score comparison.

### Phase D — Windows bridge hardening (week 3–4, parallel with C)

- D1. `BridgeHealthSnapshot` model + supervisor `bridge-heartbeat` job.
- D2. `apps/mt5-adapter` per-account routes, auth token, deep health, `X-Command-Id` idempotency, read-after-write, mock-fallback guard.
- D3. `integrations/mt5-bridge` — `/health/deep`, command idempotency, auth header.
- D4. `worker-execution/safety/bridge-gate.ts` blocks writes on stale bridge.
- D5. `/bridge` UI page + dashboard red banner on stale.

Exit criteria: killing the bridge blocks placement within 15s, paper recovers cleanly, no silent mock fallback.

### Phase E — AI critic & supervisor (week 4–5) — PRE-TRADE CRITIC COMPLETE

- ✅ E1. New workspace package `packages/ai` landed:
  - `src/models.ts` — `OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `OLLAMA_ENABLED` accessors
  - `src/client.ts` — `OllamaClient.generateJson()` with `format: "json"`, zod schema validation, retries, per-call timeout (`OLLAMA_PRETRADE_TIMEOUT_MS`), sha256 `contextDigest`, token + latency accounting
  - `src/safety.ts` — `filterPreTradeCritique()` enforces `aiSafetyInvariants`: clamps `reduceSizeMultiplier` to `[0.25, 1.0]`, clamps `confidence` to `[0, 100]`, nulls invalid `tightenStopTo`, scrubs rule-breaking language (widen stop, remove stop, increase size, override kill switch, force close, open new position) from concerns/suggestions; 14 vitest specs covering every invariant
  - `src/prompts/pretrade.ts` — `runOllamaPreTradeCritique()` with `PRETRADE_PROMPT_VERSION = pretrade-critic@1.0.0`
- ✅ E2. Pre-trade critic integrated (advisory) in `worker-execution/flow/pretrade-critic.ts`. Calls `runOllamaPreTradeCritique`, maps verdicts (`APPROVE_WITH_CAUTION` / `SUGGEST_REDUCE_SIZE` / `CONCERNED` → `APPROVE_WITH_REDUCTION`; `OBJECT` → `REJECT`), persists one `AiReview` row per call via `persistAiReview()` (kind=`PRE_TRADE_CRITIC`, full token/latency/safety-filter trail), and returns `aiReviewId` that `record.ts` stamps onto the `ExecutionDecision.preTradeAiReviewId` column. Falls back to `ABSTAIN` (no size change, no reject) when Ollama is disabled, unreachable, or returns invalid JSON — so the deterministic engine remains fully authoritative.
- ⏳ E3. Position supervisor job in `worker-supervisor` → writes `AiPositionReview`; closing-guard runs actions through deterministic safety filter before adapter call.
- ⏳ E4. Post-trade reviewer + weekly synthesis jobs.
- ⏳ E5. `/reviews`, `/lessons`, `/ai` UI pages. `api/src/modules/reviews`, `lessons`, `ai`.
- ✅ E6. Safety tests for the pre-trade critic path: 14 `packages/ai/src/safety.test.ts` specs cover "cannot increase size", "cannot remove/widen stop", "cannot override kill switch", "cannot force-close", "cannot open new position". Downstream, `flow/decide.ts` already clamps the critic multiplier via `Math.max(0, Math.min(1.0, critic.reduceSizeMultiplier))` on top of the mode multiplier so AI reductions stack multiplicatively and never widen.

Exit criteria (pre-trade path): AI reviews land in DB (`AiReview` delegate), pre-trade critic is wired into worker-execution, disabling Ollama (`OLLAMA_ENABLED=false` or an unreachable host) falls back to `ABSTAIN` without degrading placement. Remaining: supervisor + journal + UI.

### Phase F — Obsidian export (week 5)

- F1. `packages/obsidian` with vault, writer, templates, `JournalExport` model (`20260429_add_ai_and_journal` included here).
- F2. Supervisor `journal-export-sweeper` job.
- F3. Hook per-closed-trade, per-daily-metric, per-weekly-synthesis, per-lesson.
- F4. Idempotency tested — running the sweeper twice produces no new files.

Exit criteria: `/<vault>/StocksScalper/accounts/<label>/` populated and regenerates cleanly.

### Phase G — Safety, observability, rollout (week 6)

- G1. Chaos tests — kill Postgres mid-trade, kill bridge mid-trade, kill Ollama mid-trade, kill worker-execution mid-trade. System must block, not corrupt.
- G2. Per-phase / per-account dashboards finalised.
- G3. Load-test SSE gateway with 5 accounts × typical event volume.
- G4. Live enablement checklist (below).

### Live enablement checklist

- [ ] All migrations applied.
- [ ] At least two weeks of stable paper operation per account.
- [ ] Bridge stale-gate tested (induced network drop).
- [ ] Deterministic decision-engine unit tests green.
- [ ] AI circuit breaker tested.
- [ ] Obsidian regeneration idempotent.
- [ ] Kill switch (global + per-account) tested end-to-end.
- [ ] Read-after-write verification tested with induced broker delay.
- [ ] `BRIDGE_BLOCK_ON_STALE=true`, `BRIDGE_ALLOW_MOCK_FALLBACK=false`, `AI_BLOCK_ENABLED=false`.
- [ ] Operator sign-off.

---

## 15. Testing strategy

- **Unit tests** (`vitest`):
  - `packages/core/accounts/*` — phase/mode/health state machines; property tests for distance-to-breach.
  - `packages/core/allocation/*` — eligibility, fit score, policy resolution.
  - `packages/core/execution/decision-engine` — the existing test is the skeleton; add per-account rule-profile scenarios.
  - `packages/ai/safety.ts` — exhaustive guard tests.
  - `packages/obsidian/writer.ts` — path-escape prevention, atomic rename.

- **Integration tests** (vitest + real Postgres via docker-compose test profile):
  - Two accounts, one setup → ensure allocation picks the right account.
  - Stale bridge snapshot → placement blocks.
  - Ollama mock unavailable → fallback succeeds.

- **Contract tests** for the bridge (golden-file request/response pairs) — catch schema drift between adapter and Python bridge.

- **Property tests** for rule engine invariants: "no allocation may cause `openRiskPct > maxOpenRiskPct`", "no AI action may increase `distanceToDailyDdPct` by more than 0" (AI never adds risk).

- **Replay harness** — we can replay a day's candidates through the new flow against historical account snapshots to compare outcomes.

---

## 16. Observability and metrics

In addition to current audit and worker heartbeats, add:

- `account.health.{label}` — gauge.
- `account.distance_to_daily_dd_pct.{label}` — gauge.
- `allocation.fit_score.{label}` — histogram.
- `bridge.latency_ms.{nodeId}` — histogram.
- `bridge.staleness_seconds.{nodeId}` — gauge.
- `ai.latency_ms.{kind}` — histogram.
- `ai.failure_rate.{kind}` — rate.
- `ai.verdicts.{verdict}` — counter.
- `risk.violation.{ruleKey}.{outcome}` — counter.
- `placement.read_after_write_failures` — counter.

All emitted as `@stock-radar/logging` structured entries until we add a metrics backend; then Prometheus-ready naming is in place.

---

## 17. Rollback and migration safety

- Every new Prisma migration is reversible or has a documented recovery path.
- The backfill migration (`20260426_backfill_default_account`) is idempotent and uses a fixed label derived from the existing integration so re-runs are safe.
- Feature flags in `SystemSetting`:
  - `ai.enabled`, `ai.block_enabled`
  - `bridge.block_on_stale`, `bridge.allow_mock_fallback`
  - `obsidian.enabled`
  - `allocation.multi_account_enabled` (lets us ship allocation code but behave as single-account until turned on)
- Each phase of the rollout is behind one of these flags.

---

## 18. Open decisions (flag before PRs)

1. **Windows bridge multi-login.** Start single-login-per-process (recommended). Confirm.
2. **AI model choice.** `llama3.1:8b-instruct` is the default pick for a Mac Mini M4 Pro — good JSON adherence, low latency (~2–3s for our prompt size). We may want to compare with `qwen2.5:7b-instruct` and `mistral-small`. Needs a benchmark run (deferred to Phase E).
3. **Per-account kill switch UI placement.** Proposed: `/accounts/[id]` top-right, plus global one on dashboard. Confirm placement.
4. **Phase transitions — manual vs automatic.** Proposal: automatic detection (eval → funded, any-phase → breached), but the operator must *confirm* transitions that advance payout eligibility. Confirm.
5. **Obsidian vault path.** Default proposed `/Users/ekjot/Obsidian/TradingVault` — confirm actual path.
6. **Correlation groups.** We already have `Symbol.correlationGroup`. We need a starter taxonomy (USD-majors, EUR-majors, metals, indices, crypto-majors). Can ship a seeded default and iterate.
7. **Webhook-to-allocation path.** TradingView webhooks currently create candidates. Should they also carry an account-hint (e.g., `tag:funded-only`)? Proposal: yes, optional `meta.accountHint` with enforcement.

---

## 19. Acceptance criteria for "done"

The evolution is considered complete when all of the following hold simultaneously:

- The repo runs as today (`docker-compose up`) with at least two seeded accounts, each with a distinct `AccountRuleProfile` and phase.
- A single validated setup can result in (a) one account placing, (b) one account skipping with a visible fit-score-based rejection record, (c) neither placing if rule engine blocks both — and the UI explains all three cases.
- Killing the Windows bridge for node A halts placement for accounts on that node within 15s, placement for accounts on node B continues, and the dashboard surfaces the event.
- With Ollama down: placement works; supervision still emits deterministic HOLDs; `ai.failure_rate` correctly reflects the outage; no data loss.
- With Ollama up: every placed trade has an `AiTradeReview(kind=PRE_TRADE)`, every open position has an `AiPositionReview` no older than 60s, and every closed trade has a `AiTradeReview(kind=POST_TRADE)` within 5 minutes.
- Obsidian vault contains a markdown file per closed trade, one daily file per account per session, one weekly file per account per week; regenerating produces zero diffs.
- Kill switches (global, per-account, stale-bridge, phase-lock) all demonstrably block placement.
- Paper operation proves rule-profile arithmetic matches by-hand calculation for daily drawdown and trailing drawdown cases.
- No AI recommendation in the codebase can reach the broker without passing the deterministic closing guard.

---

## 20. File-by-file change map (for PR authors)

| Path | Action | Notes |
|---|---|---|
| `packages/db/prisma/schema.prisma` | EXTEND | Add enums, new models, refactor existing |
| `packages/db/prisma/migrations/20260425_*` | NEW | Core account tables |
| `packages/db/prisma/migrations/20260426_*` | NEW | Backfill |
| `packages/db/prisma/migrations/20260427_*` | NEW | Enforce not-null |
| `packages/db/prisma/migrations/20260428_*` | NEW | Allocation + exposure |
| `packages/db/prisma/migrations/20260429_*` | NEW | AI + journal |
| `packages/db/src/seed.ts` | EXTEND | Default account + profile + phase |
| `packages/types/src/accounts.ts` | NEW | Zod + types |
| `packages/types/src/allocation.ts` | NEW | — |
| `packages/types/src/exposure.ts` | NEW | — |
| `packages/types/src/supervision.ts` | NEW | — |
| `packages/types/src/ai.ts` | NEW | — |
| `packages/types/src/bridge.ts` | NEW | — |
| `packages/types/src/journal.ts` | NEW | — |
| `packages/core/src/accounts/*` | NEW | Registry, modes, health, distance |
| `packages/core/src/allocation/*` | NEW | Eligibility, fit, policies |
| `packages/core/src/portfolio/*` | NEW | Exposure, clusters, guard |
| `packages/core/src/execution/decision-engine.ts` | EXTEND | Profile-driven, account-scoped |
| `packages/core/src/risk/correlation.ts` | EXTEND | Cross-account |
| `packages/ai/*` | NEW | Ollama client, prompts, safety |
| `packages/obsidian/*` | NEW | Vault, templates, writer |
| `apps/worker-execution/src/index.ts` | REFACTOR | Split to flow/* |
| `apps/worker-execution/src/flow/*` | NEW | collect-context, allocate, pretrade-critic, decide, place, record |
| `apps/worker-execution/src/safety/bridge-gate.ts` | NEW | — |
| `apps/worker-supervisor/src/index.ts` | EXTEND | New repeat jobs |
| `apps/worker-supervisor/src/jobs/*` | NEW | bridge-heartbeat, position-supervisor, account-phase-evaluator, portfolio-exposure-snapshot, post-trade-reviewer, weekly-synthesis, journal-export-sweeper |
| `apps/mt5-adapter/src/index.ts` | REFACTOR | Per-account routes |
| `apps/mt5-adapter/src/routing.ts` | NEW | Node/account routing |
| `integrations/mt5-bridge/main.py` | EXTEND | Deep health, idempotency, auth |
| `apps/api/src/modules/accounts/*` | NEW | — |
| `apps/api/src/modules/phases/*` | NEW | — |
| `apps/api/src/modules/rule-profiles/*` | NEW | — |
| `apps/api/src/modules/allocations/*` | NEW | — |
| `apps/api/src/modules/exposure/*` | NEW | — |
| `apps/api/src/modules/reviews/*` | NEW | — |
| `apps/api/src/modules/lessons/*` | NEW | — |
| `apps/api/src/modules/bridge/*` | NEW | — |
| `apps/api/src/modules/ai/*` | NEW | NLQ endpoint |
| `apps/web/src/app/accounts/**` | NEW | — |
| `apps/web/src/app/allocations/**` | NEW | — |
| `apps/web/src/app/exposure/**` | NEW | — |
| `apps/web/src/app/reviews/**` | NEW | — |
| `apps/web/src/app/lessons/**` | NEW | — |
| `apps/web/src/app/bridge/**` | NEW | — |
| `apps/web/src/app/ai/**` | NEW | — |
| `apps/web/src/app/page.tsx` | EXTEND | Account cards, health banner |
| `apps/web/src/app/execution/page.tsx` | EXTEND | Per-account filter |
| `apps/web/src/app/portfolio/page.tsx` | EXTEND | Per-account + cluster |
| `apps/gateway/src/index.ts` | EXTEND | New event types |
| `docker-compose.yml` | EXTEND | Optional `ollama` profile, `obsidian-exporter` profile |
| `.env.local` | EXTEND | See §8.3 |
| `docs/architecture.md` | EXTEND | Keep in sync with this file |
| `docs/roadmap.md` | REPLACE | Supplanted by this file's Section 14 |

---

## 21. Appendix A — Why AI is a critic, not a trader

The LLM sees the same structured evidence the system sees. That is its entire strength: it is a *pattern-recognition second opinion* on the same reason-code stream that drives placement. It is useful because:

- It can say "these three reasoning-log entries contradict each other" faster than any rule.
- It can say "news X makes the regime assumption invalid" when that's obvious to a reader but absent from the indicator set.
- It can say "this setup's win rate has been declining in this account's last 20 trades — skip".
- It can summarise a week of trades into "repeat losers: XAUUSD longs before London open in high-vol regimes".

It is dangerous because:

- It can generate plausible-sounding recommendations that are wrong.
- It cannot be trusted to know our rule profile better than our rule profile.
- It cannot be trusted with money at risk.

So: the rule engine decides. The AI comments. The operator reads.

---

## 22. Appendix B — Why this plan does not rewrite the codebase

Every piece of the current system survives:

- `worker-news`, `worker-market`, `worker-validation` unchanged in behaviour.
- `decision-engine.ts` extended in signature, not rewritten.
- `worker-execution` split into files — *the same logic* in `flow/decide.ts` and `flow/place.ts`, just with per-account inputs and a fresh allocation step upstream.
- Prisma tables extended, none removed.
- The Python bridge gains endpoints, doesn't change protocol.
- The UI gains pages, doesn't lose any.

The evolution is *additive* with two careful refactor points: per-account scoping of execution, and splitting the worker-execution file. Both are guarded by tests and flagged until green.

---

## 23. Appendix C — Making money (honest framing)

A profitable funded-account operation is not about prediction; it is about:

1. **Surviving the variance** — sized to not breach when you're unlucky.
2. **Trading selectively** — every rule profile here exists to force selectivity.
3. **Exiting well** — this is why we built the AI position supervisor and the closing-guard.
4. **Compounding across many accounts** — the allocation engine is the system's economic engine.
5. **Learning** — `LessonLearned` + weekly synthesis + Obsidian journal make the operator *actually* review.

Expectation setting from the existing `UPGRADE_NOTES.md` ("$2k/day requires a $100k account, 55–65% win rate, 1.8:1 R/R, 8–15 trades/day") stays: this plan doesn't change the math of trading. It changes the math of *blowing up* — which is what kills funded accounts and profitability. Fewer blow-ups is the product.

---

END OF PLAN.
