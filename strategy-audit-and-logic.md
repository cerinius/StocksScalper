# StocksScalper — Strategy Audit & Logic

*Last refreshed: 2026-04-15. Owner: platform/quant ops.*

This document is the single source of truth for **what the system decides, why, and how the numbers are produced**. It is written so that a PM, a quant, or a compliance reviewer can read it end-to-end and understand every material step. Every section links the concept to the code that implements it and to the audit rows that prove it ran.

---

## 1. Platform overview

StocksScalper is an event-driven monorepo with six major roles:

| Layer | Where it lives | Role |
| --- | --- | --- |
| Market layer | `apps/worker-market` | Ingests candles, detects setups, emits `TradeCandidate` rows with `reasoningLog`. |
| Validation layer | `apps/worker-validation` | Turns each candidate into a `ValidationRun`, measures historical analogs, writes `reasonsFor` / `reasonsAgainst`, `finalValidationScore`, `expectancy`, MC drawdown. |
| Execution layer | `apps/worker-execution` + `packages/core/execution/decision-engine.ts` | Converts a validated candidate into an `ExecutionDecision` (PLACE / HOLD / SKIP / INVALIDATE), sizes the position, produces structured blocking reasons, then dispatches to the broker. |
| Risk layer | `packages/core/risk/*` | Applies portfolio, exposure, daily-loss, session, correlation, and manual-approval guardrails. Each guardrail emits a `RiskEvent` row. |
| Journal + audit | `prisma` (`Journal`, `AuditLog`) | Realised P&L trail + investigation-grade decision log, both served behind `/api/journal` and `/api/audit`. |
| UI | `apps/web` | Operator console — Trade Ideas, Validation, Execution, Journal, Audit. All screens are **server-authoritative** (SWR polls every 5–15 s) and render the same structured reason codes the workers wrote. |

The decision cadence is **one pipeline tick per bar per symbol**. The workers are idempotent — re-running a tick produces the same `ExecutionDecision.idempotencyKey`, so we never double-enter.

## 2. Idea generation (market layer)

**Input:** normalised OHLCV candles + tick tape + regime classifier output.

**Output:** a `TradeCandidate` row with:

- `symbolId`, `timeframe`, `direction`, `strategyType`, `volatilityClassification`.
- `setupScore` — how clean the pattern is in isolation.
- `confidenceScore` — initial confidence before validation (market-layer conviction only).
- `riskReward` — target / stop distance.
- `reasoningLog` — an ordered list of `{title, detail}` entries written in plain English. Every rule that voted for the setup adds one entry. This is the **narrative** — the final structured reason codes are written later by validation / execution.

**Why an idea can be missing from the UI** (the four real root causes we fixed):

1. **Candidate was created but immediately moved to `VALIDATED` / `EXECUTED`** — the old UI only showed `NEW`, so clean ideas disappeared. *Fix:* the Trade Ideas screen now shows all statuses by default and uses an **Actionable only** toggle (`NEW | SCANNED | VALIDATING | VALIDATED`) rather than silently filtering.
2. **The ingest worker stalled** and the UI still rendered an empty panel with no signal. *Fix:* every list panel now shows `Updated Xs ago` in the toolbar; once the gap crosses 60 s the dot turns amber so a stalled pipeline is obvious at a glance.
3. **Filters were too narrow** (e.g. user left a timeframe filter on). The old UI couldn't distinguish "no data" from "filtered out". *Fix:* the backend now returns an `emptyReason` of `no_data_yet | no_matches | filter_too_narrow | loading_failed | no_permission` in the `ListEnvelope.meta`, and the `EmptyState` component renders a different title, icon, and recommended action for each.
4. **Sort was non-deterministic** so newest rows landed on page 2. *Fix:* every list endpoint now appends a **stable tiebreaker chain** (`[{sortField: dir}, {detectedAt: "desc"}, {id: "desc"}]`) so the newest idea is *always* on page 1.

## 3. Validation (historical analogs + rule scoring)

`worker-validation` picks up every candidate in `SCANNED` and produces a `ValidationRun`.

### 3.1 Analog mining

For each candidate the worker pulls up to `N` historical bars that matched the same structural fingerprint (strategy, timeframe, regime, proximity to key levels). Each match becomes a `BacktestResult` with:

- `similarityScore` (0–1)
- `outcomeR` — realised R multiple
- `holdBars` — time to hit stop or target
- A flag for `isSynthetic` when the pool is so thin we had to run a Monte-Carlo substitute.

### 3.2 Scoring

| Input | Weight | Notes |
| --- | --- | --- |
| Sample size | 25 % | Need ≥ 8 real analogs or we fall back to `VALIDATION_FAILED_SAMPLE`. |
| Win-rate estimate | 20 % | Weighted by similarity. |
| Expectancy (R) | 25 % | Must be strictly > 0, or we emit `VALIDATION_FAILED_EXPECTANCY`. |
| Profit factor | 10 % | |
| Monte-Carlo drawdown 95 % | 10 % | Cap at 22 % of account. |
| Risk of ruin | 10 % | Cap at 4 %. |

The weighted score is `finalValidationScore` (0–100). We store `confidenceScore`, `profitFactor`, `maxDrawdown`, `monteCarlo.{drawdownPct95, riskOfRuinPct}` in `backtestMetadata`, and `realAnalogCount` for provenance.

### 3.3 Reasons

Every run writes **at least one structured audit row**:

- `VALIDATION_PASSED` on success.
- `VALIDATION_FAILED_SAMPLE`, `VALIDATION_FAILED_EXPECTANCY`, or `VALIDATION_FAILED_SCORE` on rejection.
- `VALIDATION_SYNTHETIC_FALLBACK` as a secondary row when `realAnalogCount === 0` so compliance can see the decision leaned on simulated data.

Each row carries `observed` (the actual numbers we saw), `expected` (the threshold we required), `remediation` (a one-sentence hint), and `lineage` (parent `candidateId`, the `ValidationRun.id`, `correlationId`).

## 4. Execution decision engine

`packages/core/src/execution/decision-engine.ts` is the single place that converts `ValidationRun + risk state + portfolio` into a `StructuredDecision` with one of four actions:

| Action | When | Structured code |
| --- | --- | --- |
| `PLACE` | All gates passed, position sized successfully. | `EXECUTION_ENTERED` |
| `HOLD` | No blocker, but one warning we want a human to review (e.g. low liquidity). | `EXECUTION_HELD` (or `EXECUTION_MANUAL_APPROVAL` if operator has toggled manual mode). |
| `SKIP` | At least one warning-severity blocker. | `EXECUTION_SKIPPED` |
| `INVALIDATE` | At least one critical-severity blocker. | `EXECUTION_INVALIDATED` |

### 4.1 Inputs

- `validation` — output of §3.
- `portfolio` — open positions, realised & unrealised P&L for the session.
- `riskLimits` — account-level settings (`dailyLossCapPct`, `maxConcurrent`, `perSymbolCap`, `manualApprovalMode`, `sessionWindow`).
- `market` — last trade, spread, depth, halts, next earnings distance.

### 4.2 Gates (in order)

1. **Session gate** — reject outside `riskLimits.sessionWindow`.
2. **Daily loss** — reject if realised loss ≥ `dailyLossCapPct × equity`.
3. **Concurrent positions** — reject if `openCount ≥ maxConcurrent`.
4. **Per-symbol cap** — reject if this symbol already has `perSymbolCap` exposure.
5. **Correlation cap** — reject if correlated basket exposure would exceed `corrBasketCap`.
6. **Liquidity** — warn if ADV < 3× intended fill size.
7. **Spread** — reject if quoted spread > `maxSpreadBps`.
8. **Earnings window** — reject if next earnings < `earningsBufferDays`.
9. **Halt / LULD** — reject if the exchange feed flags the symbol halted.
10. **Validation score** — reject if `finalValidationScore < minScore` or `expectancy ≤ 0`.

Every gate contributes a `DecisionRecord` with code, severity, `observed`, `expected`, and a plain-English `explanation`. These flow through as `structuredReasons` / `structuredBlockingReasons` on the `ExecutionDecision` row **and** as one-per-blocker audit rows, so "why was this skipped" is a one-click filter on the audit page.

### 4.3 Sizing

On `PLACE`:

- `qty = round_lot(riskPerTrade × equity / stopDistance)`.
- Capped by `perSymbolCap`, free buying power, and 10 % of ADV.
- Entry is a `LIMIT` at a fill-able offset inside the bid/ask (direction-aware), stop and target are bracketed orders.

## 5. Risk layer

`RiskEvent` rows are the durable trail of every guardrail firing. They are created **before** the `ExecutionDecision` is written, so an ordered read (`correlationId`) reproduces the decision tree exactly. Blocking risk events carry `blocking: true`; informational ones do not.

The Risk events tab on the Execution page surfaces these with severity chips and a "Blocking only" toggle.

## 6. Order lifecycle

`worker-execution` listens for `PLACE` decisions and forwards them to the broker adapter:

- Every order goes through `PENDING → SUBMITTED → FILLED | REJECTED | CANCELED`.
- `errorMessage` from the broker is stored verbatim so the Orders tab can render the broker response.
- On fill we open a `Position` and write a matching `Journal` entry when the position closes.

## 7. Journaling & audit model

Two separate tables with different contracts.

### 7.1 `Journal`

- **Scope:** realised closed trades only.
- **Contract:** `{symbol, setupType, entry, stop, target, pnl, openedAt, closedAt}`.
- **Purpose:** quick tax / performance review. Rendered at `/journal`.

### 7.2 `AuditLog`

- **Scope:** every meaningful decision — not just trades. Idea survived, validation ran, execution was skipped, risk fired, broker errored, override was issued.
- **Columns:** `severity`, `actorType`, `actorId`, `workerType`, `category`, `entityType`, `entityId`, `correlationId`, `createdAt`, `message`, `data`.
- **Structured payload:** `data.structured` conforms to `DecisionRecord` (see `packages/shared/decision-codes.ts`):
  - `code` — machine label, one of `DECISION_CODES.*`.
  - `category` — `idea | validation | execution | risk | broker | system`.
  - `severity` — `info | notice | warning | critical`.
  - `title` — short human phrase.
  - `explanation` — 1–2 sentence plain English.
  - `observed` — actual metric values (e.g. `{sampleSize: 3, expectancy: -0.1}`).
  - `expected` — thresholds we required (e.g. `{sampleSize: "≥ 8", expectancy: "> 0"}`).
  - `remediation` — what to change to unblock this class of rejection.
  - `tags` — free text tokens for filtering.
  - `at` — ISO timestamp.
- **UI:** the Audit page renders the structured payload as a `ReasonCard`, plus a lineage block (`Entity · Correlation · Worker · Actor`) and two copy buttons: **Copy JSON** (the whole row) and **Copy explanation** (just the human narrative, for pasting into Slack).

### 7.3 Correlation IDs

Every pipeline pass sets a fresh `correlationId = sha256(symbol + bar-ts)`. Every child event inherits it, so filtering the audit page by `correlationId` yields the complete decision tree (1 ingest row → N validation rows → 1 execution row → 0..M risk rows → 0..1 order rows). This is how post-trade review answers "what did we know at the moment we decided to take this trade?"

## 8. UI contracts

All list endpoints return a uniform envelope:

```ts
interface ListEnvelope<T> {
  items: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    pageCount: number;
    hasMore: boolean;
    generatedAt: string;
    appliedFilters: Record<string, unknown>;
    sort: { field: string; direction: "asc" | "desc" };
    emptyReason?: "no_data_yet" | "no_matches" | "filter_too_narrow" | "loading_failed" | "no_permission";
    emptyMessage?: string;
  };
}
```

Every page uses this envelope to drive:

- `ListToolbar` — `Updated Xs ago` pill, total count, filter bar, refresh button, pagination.
- `DataTable` — sticky headers, sortable columns with stable tiebreaker, expandable rows.
- `EmptyState` — reason-aware copy + `Clear filters` / `Refresh` actions and a dev-only debug block showing `appliedFilters`.

## 9. Copy standards

All user-facing strings were rewritten against this house style:

- Action-first headings (`Realised trade history`, not `Journal page`).
- Numbers where possible (`12 open · updated 4s ago`, not `Some data`).
- Reasons read like a sentence (`Expectancy was -0.10 R; we need > 0 R before placing.`), not enum values.
- Empty states tell the user what to do next (`Clear filters` / `Widen timeframe` / `Check ingest worker health`).

## 10. Known weaknesses

These are documented so the next reviewer can weight them:

1. **Synthetic analog fallback.** When real analogs < 8 we synthesise using the historical volatility cone. These runs carry a `VALIDATION_SYNTHETIC_FALLBACK` audit row, but the UI still shows them in the main validation list. A future improvement is a first-class "synthetic" tab so reviewers can opt into vs. opt out of them.
2. **Correlation estimate is rolling 20-day.** It misses regime flips inside a session. The risk layer therefore errs conservative (higher baseline `corrBasketCap`) at the cost of passing on some good trades.
3. **Broker rejections are not auto-retried.** Deliberately — we prefer a clean `REJECTED` row to a silent resubmission. Operators can re-enqueue from the Orders tab.
4. **Earnings calendar** comes from a single vendor. If the feed is late we fall back to the last known date, which can miss a same-day release. The `earnings_stale` audit code flags these.
5. **Sample sizes are bar-denominated, not time-denominated.** In quiet regimes the 8-bar minimum may still represent thin data. A wall-clock floor is tracked in the backlog.

## 11. Open questions

- Should `HOLD` be an actionable state for operators (take it manually) or strictly a flag for the next tick? Today it is both, which is ambiguous.
- Where should portfolio-level P&L stops live — in `riskLimits` (enforced per decision) or in a separate supervisor that can pre-empt open positions? Current code is enforced per decision, so a runaway position held inside a bar can still breach before the next tick.
- Do we want the Journal to include PAPER trades? Today it only contains live-fills; paper trades live in `AuditLog` with `actorType=SYSTEM` but never in `Journal`.

## 12. File map (for future maintainers)

| Concern | File |
| --- | --- |
| Decision codes catalogue | `packages/shared/src/decision-codes.ts` |
| `DecisionRecord` builder | `packages/shared/src/decision-codes.ts` (`buildDecisionRecord`) |
| Execution engine | `packages/core/src/execution/decision-engine.ts` |
| Validation worker | `apps/worker-validation/src/index.ts` |
| Execution worker | `apps/worker-execution/src/index.ts` |
| List envelope + fetcher | `apps/web/src/lib/api.ts` |
| Toolbar | `apps/web/src/components/list-toolbar.tsx` |
| Data table | `apps/web/src/components/data-table.tsx` |
| Filter chips / search / grouping | `apps/web/src/components/filter-chips.tsx` |
| Reason rendering | `apps/web/src/components/reason-list.tsx` |
| Empty state | `apps/web/src/components/empty-state.tsx` |
| Trade Ideas screen | `apps/web/src/app/trade-ideas/page.tsx` |
| Validation screen | `apps/web/src/app/validation/page.tsx` |
| Execution screen | `apps/web/src/app/execution/page.tsx` |
| Audit screen | `apps/web/src/app/audit/page.tsx` |
| Journal screen | `apps/web/src/app/journal/page.tsx` |

---

*If you change any decision code, threshold, or gate, update this document in the same PR. The audit reviewer assumes it is current.*
