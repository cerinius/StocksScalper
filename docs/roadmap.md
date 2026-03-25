# Tier-1 Roadmap

This roadmap maps the proposed next-generation trading features onto the current Stock Radar Control Tower architecture. It is intentionally codebase-specific so we can turn ideas into work without losing the strengths of the current platform: local-first operation, explainability, isolated workers, and hard risk controls.

## Current Baseline

The platform already has a usable event loop:

- `worker-news` scores and stores news
- `worker-market` creates candidates from price bars plus news
- `worker-validation` attaches analog-based validation
- `worker-execution` converts validated candidates into structured decisions and paper orders
- `worker-supervisor` monitors health, creates summaries, and dispatches notifications

That means the next step is not "start over." The next step is to deepen the signal layer, strengthen validation, and make execution smarter without breaking the existing control plane.

## Recommended Build Order

### Phase 1: Highest Leverage, Lowest Architectural Risk

- correlation matrix and correlation-aware sizing
- shadow portfolio
- walk-forward validation
- Monte Carlo stress testing
- recursive feedback loop from live performance back into risk settings

These all fit naturally into the current schema and worker model, and they improve decision quality before we take on heavier data and model infrastructure.

### Phase 2: Market Microstructure And Smarter Execution

- tick ingestion from MT5 or another market-data source
- VWAP bands, CVD, and order-flow divergence features
- TWAP/VWAP order slicing
- CVaR-aware position sizing

These require a richer data plane and new persistence, but they slot well into the current `worker-market` and `worker-execution` split.

### Phase 3: Advanced Modeling And New Data Products

- multi-horizon regime detection with HMM or GMM
- sentiment engine for filings, transcripts, and long-form text
- foundation-model forecasting adapter
- dynamic Kelly sizing backed by stronger validation evidence
- feature store
- performance attribution dashboard

These are the most powerful ideas here, but they depend on the data consistency and evaluation layers above.

## Alpha Layer

### 1. Multi-Horizon Regime Detection

Goal:

- classify each symbol and timeframe into regimes such as `trend_low_vol`, `trend_high_vol`, `range_low_vol`, `range_high_vol`, `bear_breakdown`, or similar
- let strategy selection change automatically by regime instead of using one scoring personality everywhere

Why it fits this repo:

- `packages/core/src/analysis/market-scan.ts` already converts bar data into a candidate
- `apps/worker-market/src/index.ts` is the right place to branch strategy families by regime before candidate creation
- `MarketSnapshot.volatilityRegime` already exists in Prisma and can become the first storage target

Suggested implementation touchpoints:

- add `packages/core/src/analysis/regime.ts`
- extend `packages/types/src/index.ts` with a typed regime enum or string union
- enrich `MarketIndicatorSnapshot` or `featureValues` with regime probabilities and confidence
- write regime state into `MarketSnapshot.volatilityRegime`, `MarketSnapshot.indicatorSnapshot`, and `TradeCandidate.featureValues`
- modify `analyzeMarketCandidate` so strategy selection depends on regime instead of only momentum and RSI

Suggested first version:

- start with a deterministic clustering baseline using volatility, trend, and volume
- add GMM before HMM
- only add HMM once we want state transition memory and regime persistence across bars

### 2. Order Flow And Microstructure

Goal:

- move from bar-only signals to tape-informed signals
- detect buyer and seller aggression through VWAP deviation, CVD, and divergence

Why it fits this repo:

- the current market worker already builds `MarketSnapshot`
- the MT5 adapter is the natural boundary for streaming or polling tick data
- `featureValues` and `indicatorSnapshot` are already flexible JSON fields

Suggested implementation touchpoints:

- extend `apps/mt5-adapter/src/index.ts` with tick ingestion or retrieval endpoints
- add Prisma models such as `Tick`, `OrderFlowSnapshot`, or `MicrostructureSnapshot`
- add `packages/core/src/analysis/order-flow.ts`
- add VWAP standard deviation bands and CVD calculations
- surface order-flow divergence in `reasoningLog` so the decision remains explainable

Prerequisites:

- reliable tick feed
- symbol-level clock synchronization
- storage retention policy, because tick data grows fast

### 3. Time-Series Foundation Model Adapter

Goal:

- add a forecasting or pattern-recognition layer that can score candidate continuation, reversal, or risk asymmetry without hand-coding every chart pattern

Why it fits this repo:

- the provider pattern already exists in `packages/core/src/providers/*`
- `worker-validation` can consume model outputs as another evidence source
- `worker-market` can use the forecast confidence as another feature rather than replacing the whole stack

Suggested implementation touchpoints:

- add a forecast provider interface under `packages/core/src/providers`
- create a new adapter for a foundation-model backend
- store forecast outputs in `TradeCandidate.featureValues`, `TradeCandidate.reasoningLog`, and `ValidationRun.backtestMetadata`
- optionally isolate this into a new `worker-forecast` if inference latency becomes meaningful

Guardrail:

- use the model as a scored feature, not as an opaque final decision-maker

## Validation Layer

### 4. Walk-Forward Optimization

Goal:

- evaluate strategy behavior across rolling train-test windows instead of static backtests
- prevent overfitting and detect parameter instability

Why it fits this repo:

- the existing validation path already stores run-level metrics and backtest metadata
- the older analytics stack in `packages/core/src/analytics/backtest.ts` can be reused for the simulation engine

Suggested implementation touchpoints:

- add `packages/core/src/analytics/walk-forward.ts`
- extend `apps/worker-validation/src/index.ts` to run WFO jobs for validated strategies
- store window-level outputs in new Prisma models such as `WalkForwardRun` and `WalkForwardWindow`, or store an initial version in `ValidationRun.backtestMetadata`
- expose summary metrics in `/api/validation`

Key outputs to persist:

- in-sample vs out-of-sample expectancy
- parameter stability
- regime-by-regime performance
- degradation slope across windows

### 5. Monte Carlo Simulations

Goal:

- estimate drawdown distribution, tail behavior, and risk of ruin from trade-sequence uncertainty

Why it fits this repo:

- execution decisions, validations, and journal-like outcomes are already persisted
- the supervisor can use Monte Carlo outputs to tighten risk automatically

Suggested implementation touchpoints:

- add `packages/core/src/analytics/monte-carlo.ts`
- extend `worker-validation` to compute simulation summaries after each meaningful batch of completed trades or validation runs
- add Prisma storage for `MonteCarloRun` and percentile metrics, or store early results under `SystemSetting` plus validation metadata
- expose drawdown percentiles to the dashboard and execution layers

Key outputs to persist:

- expected max drawdown
- 95th and 99th percentile drawdown
- probability of ruin
- confidence range for CAGR and expectancy

## Execution Layer

### 6. VWAP And TWAP Execution Workers

Goal:

- break larger orders into child slices to reduce market impact and slippage

Why it fits this repo:

- the current execution worker already separates decision generation from broker interaction
- the adapter boundary is isolated enough to support parent and child orders

Suggested implementation touchpoints:

- add new Prisma models such as `ExecutionSchedule`, `ExecutionSlice`, and `ChildOrder`
- extend `packages/types/src/index.ts` with execution algo metadata
- split `worker-execution` into:
  - decision creation
  - order scheduling
  - child-order dispatch and reconciliation
- add scheduling logic under `packages/core/src/execution/slicing.ts`
- expand `apps/mt5-adapter/src/index.ts` to accept child-order instructions

Recommended first version:

- start with TWAP because it is simpler and deterministic
- add VWAP once intraday volume curves are available

### 7. CVaR-Based Position Sizing

Goal:

- size positions using expected tail loss instead of only point stop distance

Why it fits this repo:

- `makeExecutionDecision` already computes risk and quantity centrally
- the execution layer already receives validation metrics and account state

Suggested implementation touchpoints:

- extend `packages/core/src/execution/decision-engine.ts`
- add tail-risk metrics to `ValidationMetrics`
- store CVaR assumptions inside `ExecutionDecision.executionParameters` and `reasons`
- expose CVaR in execution and portfolio views

Key rule:

- if CVaR exceeds the configured tail budget, reduce size even if the setup score is strong

## Architectural Additions

### 8. Sentiment Engine

Goal:

- score filings, earnings transcripts, and long-form text instead of relying only on short headlines

Suggested implementation touchpoints:

- add `worker-sentiment`
- add `packages/core/src/nlp/sentiment.ts`
- create new tables such as `DocumentIngestion`, `DocumentSentiment`, and `EntityMention`
- feed summary sentiment into `NewsItem.metadata` or into a dedicated feature store

Best use in this repo:

- augment `worker-news`, do not replace it

### 9. Correlation Matrix

Goal:

- prevent disguised concentration by measuring symbol and sector co-movement

Why it fits this repo:

- `TradeCandidate.correlationTags` and exposure checks already exist
- this is one of the easiest high-value upgrades

Suggested implementation touchpoints:

- add `packages/core/src/risk/correlation.ts`
- compute rolling correlations from `PriceBar`
- persist a matrix or summarized exposures in a new `CorrelationSnapshot` table
- replace static tag-based correlation checks in `makeExecutionDecision` with data-driven cluster exposure

Recommended priority:

- build this early

### 10. Dynamic Kelly Criterion

Goal:

- modulate position sizing based on estimated edge quality

Why it fits this repo:

- validation already produces expectancy and win-rate estimates
- execution already owns quantity calculation

Suggested implementation touchpoints:

- add `packages/core/src/risk/kelly.ts`
- compute fractional Kelly from validation expectancy, win rate, and drawdown limits
- cap Kelly size with CVaR and portfolio constraints
- write final size rationale into `ExecutionDecision.reasons`

Guardrail:

- use fractional Kelly only
- never let Kelly override hard portfolio limits

### 11. Feature Store

Goal:

- centralize derived features so every worker uses identical inputs

Why it fits this repo:

- today features are recomputed inside workers and stored ad hoc in JSON
- a shared feature layer will reduce drift once regime, sentiment, order flow, and model outputs all exist

Suggested implementation touchpoints:

- add a feature ingestion and retrieval layer under `packages/core/src/features`
- persist hot features in Redis and durable versions in Postgres
- create tables such as `FeatureSet`, `FeatureValue`, and `FeatureSnapshot`
- make `worker-market`, `worker-validation`, and `worker-execution` read from feature snapshots by version

Recommended rule:

- do not build this before we have at least three independent advanced feature families to unify

## Additional Platform Ideas

### 12. Shadow Portfolio

Goal:

- simulate every trade idea, including the ones that were skipped or blocked

Why it fits this repo:

- this directly answers "what did we miss?"
- it is a perfect companion to the current explainable decision architecture

Suggested implementation touchpoints:

- add a `worker-shadow`
- create tables such as `ShadowDecision`, `ShadowOrder`, and `ShadowPosition`
- have `worker-market` or `worker-execution` fan out every candidate into the shadow book
- compare shadow outcomes against live or paper decisions in analytics

Recommended priority:

- very high

### 13. Performance Attribution

Goal:

- separate market beta from true entry and exit edge

Suggested implementation touchpoints:

- add `packages/core/src/analytics/attribution.ts`
- store benchmark returns and factor context per trade
- add API module plus UI screen for attribution
- decompose PnL into market drift, sector drift, timing alpha, and execution impact

Why it matters:

- this is how we prove the system has edge instead of simply being long a risk-on environment

### 14. Recursive Feedback Loop

Goal:

- automatically reduce risk when realized live performance underperforms expected validation behavior

Why it fits this repo:

- `worker-supervisor` already monitors health and writes notifications
- `SystemSetting` already exists and can carry adaptive risk overrides

Suggested implementation touchpoints:

- add performance monitoring under `packages/core/src/supervisor/performance.ts`
- compare realized rolling metrics against validation expectations
- let `worker-supervisor` lower `risk.maxRiskPerTradePct` or activate stricter approval modes through `SystemSetting`
- write every automatic change to `AuditLog` and `RiskEvent`

Recommended rule:

- automatic tightening is allowed
- automatic loosening should require human approval

## Concrete Schema Additions To Expect

The current Prisma schema is already a good base, but the roadmap likely needs new models for:

- tick and microstructure data
- regime states or regime snapshots
- walk-forward runs and windows
- Monte Carlo runs
- correlation snapshots
- execution schedules and child orders
- shadow portfolio entities
- feature snapshots and feature definitions
- document sentiment or NLP outputs
- attribution results

## What To Build Next

If the goal is to reach a much stronger version of the current platform without blowing up complexity, the best next sequence is:

1. Correlation matrix inside the execution engine.
2. Shadow portfolio for all accepted and rejected ideas.
3. Walk-forward validation plus Monte Carlo drawdown stats.
4. Supervisor feedback loop that reduces size when realized performance drifts below expectation.
5. Tick ingestion plus TWAP execution.
6. Regime detection.
7. Order-flow features.
8. Foundation-model and sentiment adapters.

That order gives us better risk control and better evaluation before we spend time on heavier modeling infrastructure.
