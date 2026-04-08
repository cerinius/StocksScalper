# StocksScalper — Upgrade Notes

## What Was Changed

### 1. Yahoo Finance Market Data Provider (NEW)
**File:** `packages/core/src/providers/yahoo-finance-market.ts`

Replaces the Alpha Vantage free tier (5 calls/min limit) with Yahoo Finance's
public chart API — completely free, no API key needed, no rate limit issues.

Supports all timeframes (1m, 5m, 15m, 1h, 4h, 1d) and all asset classes:
- US stocks and ETFs: AAPL, SPY, QQQ, etc.
- Crypto: BTCUSD → BTC-USD (auto-mapped)
- Forex: EURUSD → EURUSD=X (auto-mapped)
- Commodities: XAUUSD → GC=F (Gold Futures, auto-mapped)

### 2. Real Historical Analog Engine (MAJOR FIX)
**File:** `apps/worker-validation/src/index.ts`

The old validation worker generated **fake synthetic analogs** based only on
setup score arithmetic. This made the entire validation step meaningless.

The new engine:
1. Fetches real stored price bars from the database
2. Normalises the current 20-bar pattern into percentage returns
3. Slides a window over all stored history to find similar patterns
4. Uses Pearson correlation to score similarity
5. Records the actual future outcome of each matching pattern
6. Falls back to adaptive synthetics only when < 3 real matches exist

This means the longer the system runs and accumulates price history, the more
accurate and meaningful the validation scores become.

### 3. Enhanced Technical Indicators (FIXED + NEW)
**File:** `packages/core/src/analysis/indicators.ts`

**Fixed:**
- **MACD signal line** was wrong (`line * 0.8`). Now properly computed as EMA(9)
  of the MACD line, with correct histogram = MACD - signal.
- **EMA calculation** improved with proper Wilder seeding for ATR and ADX.

**New indicators added:**
| Indicator | Signal Use |
|---|---|
| Bollinger Bands (20, 2) | Squeeze detection, mean-reversion levels |
| Stochastic RSI (14, 3, 3) | Momentum confirmation, overbought/oversold |
| OBV (On Balance Volume) | Accumulation/distribution, volume trend |
| VWAP | Institutional price level, bias confirmation |
| ADX (14) | Trend strength quantification |
| +DI / -DI | Directional trend bias from ADX |
| Williams %R (14) | Overbought/oversold extremes |
| CCI (20) | Commodity Channel Index for deviation from average |

### 4. Enhanced Market Scan Algorithm
**File:** `packages/core/src/analysis/market-scan.ts`

The market scan now uses a **vote-based direction inference** system instead of
a single metric. Ten independent signal groups each cast a weighted vote:

1. Regime bias (2.0 weight)
2. EMA trend alignment (1.5)
3. MACD histogram direction (1.0)
4. RSI momentum (0.8)
5. Stochastic RSI cross (0.7)
6. Price vs VWAP (0.9)
7. Bollinger Band position (0.6)
8. OBV accumulation/distribution (0.8)
9. ADX + DI direction (1.1)
10. News directional bias (0.5 per item)

**Quality gate raised:** Candidates now require:
- Setup score ≥ 62 (was 60)
- At least 60% directional agreement among signals
- At least 3 independent signal votes

### 5. Enhanced Regime Detection
**File:** `packages/core/src/analysis/regime.ts`

Now incorporates:
- **ADX** for objective trend strength confirmation
- **Bollinger Band width** for squeeze vs expansion detection
- **OBV** for accumulation/distribution confirmation in trend regimes

### 6. Finnhub News Provider (NEW)
**File:** `packages/core/src/providers/finnhub-news.ts`

Free tier at finnhub.io (60 requests/minute). Provides:
- Company-level news for equities (AAPL, NVDA, etc.)
- Market-level news for forex, crypto, general macro
- Basic sentiment inference (positive/negative/neutral)

**To activate:** Get a free key at https://finnhub.io/register and add it to
`.env.local` as `FINNHUB_API_KEY=your_key_here`, then set `NEWS_PROVIDER=finnhub`.

### 7. Provider Factories
**File:** `packages/core/src/providers/index.ts`

Added `createMarketDataProvider()` factory function so workers don't need to
hard-code provider selection logic. The factory respects `MARKET_DATA_PROVIDER`
and falls back gracefully when API keys are missing.

### 8. Updated Configuration
**File:** `.env.local`

- `MARKET_DATA_PROVIDER=yahoo_finance` (was: alpha_vantage)
- `NEWS_PROVIDER=finnhub` (was: alpha_vantage) — needs FINNHUB_API_KEY
- `WATCHLIST_SYMBOLS` expanded to 14 symbols including META, AMZN, GOOGL
- `WATCHLIST_TIMEFRAMES=5m,15m,1h,1d` (removed 1m — too noisy)
- `MARKET_SCAN_INTERVAL_MS=45000` (was 60000)
- `NEWS_LIMIT=50` (was 25)
- `MAX_ACTIVE_TRADES=6` (was 4)
- `STALE_SIGNAL_SECONDS=240` (was 300)

---

## Quick Start After Upgrade

```bash
# 1. Get a free Finnhub API key (takes 30 seconds)
#    https://finnhub.io/register
#    Add FINNHUB_API_KEY=your_key to .env.local

# 2. Rebuild the TypeScript packages
npm run build --workspace=packages/types
npm run build --workspace=packages/config
npm run build --workspace=packages/core

# 3. Restart Docker services
docker compose down
docker compose up --build
```

---

## Important Reality Check on Profit Targets

To generate $2,000/day consistently from automated trading requires:

| Factor | Requirement |
|---|---|
| Account size | ~$100,000 (2% daily target) |
| Win rate | 55–65% after costs |
| Average R/R | 1.8:1 or better |
| Trades/day | 8–15 quality setups |
| Slippage/fees | Must be < 0.05% per trade |

**The system is currently in paper mode** — run it in paper mode for at least
2–4 weeks to verify the signals are generating consistent positive expectancy
before committing real capital. Check the Validation and Execution tabs in the
operator dashboard for performance data.

The algorithms have been significantly improved but no trading system is
risk-free. Always use proper position sizing and never risk more than you can
afford to lose.
