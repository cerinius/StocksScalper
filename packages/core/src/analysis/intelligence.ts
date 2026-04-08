/**
 * Intelligence Layer — Adaptive Trading Brain
 *
 * Three high-impact modules:
 *
 *  1. Session Filter — rejects trades during low-liquidity windows where spreads
 *     blow out and signals have lower reliability (Asian dead-zone for FX, etc.)
 *
 *  2. ATR Trailing Stop Engine — moves stop-loss to lock in profits as price
 *     advances, using real ATR so it adapts to current volatility.
 *
 *  3. Streak Risk Scaler — cuts position size after consecutive losses (cold
 *     streak) and gradually restores it as performance recovers. Prevents a
 *     string of losses from compounding into account damage.
 *
 *  4. Multi-Timeframe Confluence — checks that the signal direction aligns
 *     across multiple timeframes before approving a candidate.
 */

import type { PriceBar } from "@stock-radar/types";

// ─── 1. Session Filter ────────────────────────────────────────────────────────

export type AssetClass = "CRYPTO" | "FX" | "EQUITY" | "COMMODITY" | "ETF";

interface SessionWindow {
  startHourUTC: number;
  endHourUTC: number;
  label: string;
}

const SESSIONS: Record<string, SessionWindow> = {
  sydney:    { startHourUTC: 21, endHourUTC: 6,  label: "Sydney" },
  tokyo:     { startHourUTC: 0,  endHourUTC: 9,  label: "Tokyo" },
  london:    { startHourUTC: 7,  endHourUTC: 16, label: "London" },
  new_york:  { startHourUTC: 12, endHourUTC: 21, label: "New York" },
};

// High-quality FX trading: London open, NY open, London/NY overlap
const PRIME_FX_HOURS_UTC = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
// Equity hours: NYSE/NASDAQ regular session (13:30–20:00 UTC)
const EQUITY_HOURS_UTC = new Set([13, 14, 15, 16, 17, 18, 19]);
// Commodity (Gold/Oil): London + NY overlap
const COMMODITY_HOURS_UTC = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

export interface SessionCheckResult {
  allowed: boolean;
  reason: string;
  currentSession: string;
  liquidityScore: number; // 0-100, higher = better
}

export const checkSessionQuality = (
  assetClass: AssetClass,
  nowUtc: Date = new Date(),
): SessionCheckResult => {
  const hourUTC = nowUtc.getUTCHours();
  const dayOfWeek = nowUtc.getUTCDay(); // 0=Sunday, 6=Saturday

  // Weekend check — equities and most FX are closed
  if (dayOfWeek === 0 && hourUTC < 21) {
    // Sunday before Sydney open is dead zone for FX/commodities
    if (assetClass !== "CRYPTO") {
      return { allowed: false, reason: "Weekend dead zone — market closed", currentSession: "closed", liquidityScore: 0 };
    }
  }
  if (dayOfWeek === 6) {
    // Saturday: equities closed; FX/commodities thin; crypto still runs
    if (assetClass === "EQUITY" || assetClass === "ETF") {
      return { allowed: false, reason: "Market closed on Saturday", currentSession: "closed", liquidityScore: 0 };
    }
    if (assetClass === "FX" || assetClass === "COMMODITY") {
      return { allowed: false, reason: "FX/Commodity market closed on Saturday", currentSession: "closed", liquidityScore: 0 };
    }
  }

  // Crypto trades 24/7 — always allowed but note peak hours
  if (assetClass === "CRYPTO") {
    const isHighLiquidity = hourUTC >= 8 && hourUTC <= 22; // London/NY hours have best crypto volume
    return {
      allowed: true,
      reason: isHighLiquidity ? "Crypto peak liquidity window" : "Crypto off-peak (lower volume)",
      currentSession: "crypto-24-7",
      liquidityScore: isHighLiquidity ? 85 : 55,
    };
  }

  // FX
  if (assetClass === "FX") {
    if (PRIME_FX_HOURS_UTC.has(hourUTC)) {
      const isOverlap = hourUTC >= 12 && hourUTC <= 16; // London/NY overlap — peak of peak
      return {
        allowed: true,
        reason: isOverlap ? "London/NY overlap — maximum FX liquidity" : "Active FX session",
        currentSession: isOverlap ? "london-ny-overlap" : "active-fx",
        liquidityScore: isOverlap ? 100 : 80,
      };
    }
    return {
      allowed: false,
      reason: `Asian dead zone (UTC ${hourUTC}:00) — FX spreads wide, avoid trading`,
      currentSession: "asian-thin",
      liquidityScore: 20,
    };
  }

  // Equity / ETF
  if (assetClass === "EQUITY" || assetClass === "ETF") {
    if (hourUTC === 13) {
      // First 30 min can be volatile — allow but flag
      return { allowed: true, reason: "Market open (volatile first 30 min)", currentSession: "market-open", liquidityScore: 65 };
    }
    if (EQUITY_HOURS_UTC.has(hourUTC)) {
      const isPowerHour = hourUTC >= 19; // last hour of trading
      return {
        allowed: true,
        reason: isPowerHour ? "Power hour — high equity volume" : "Regular equity session",
        currentSession: isPowerHour ? "power-hour" : "regular-session",
        liquidityScore: isPowerHour ? 90 : 85,
      };
    }
    return {
      allowed: false,
      reason: "Outside NYSE/NASDAQ regular session (13:30–20:00 UTC)",
      currentSession: "pre-post-market",
      liquidityScore: 10,
    };
  }

  // Commodity (Gold, Silver, Oil)
  if (assetClass === "COMMODITY") {
    if (COMMODITY_HOURS_UTC.has(hourUTC)) {
      return { allowed: true, reason: "Active commodity session", currentSession: "commodity-active", liquidityScore: 80 };
    }
    return { allowed: false, reason: "Low commodity liquidity outside London/NY hours", currentSession: "thin", liquidityScore: 15 };
  }

  return { allowed: true, reason: "Session check passed", currentSession: "unknown", liquidityScore: 70 };
};

// ─── 2. ATR Trailing Stop Engine ──────────────────────────────────────────────

export interface TrailingStopResult {
  newStopLoss: number;
  moved: boolean;
  distanceAtr: number;
  atr: number;
}

/**
 * Computes an ATR-based trailing stop for an open position.
 *
 * Rules:
 *  - Calculates the current ATR(14) from recent price bars
 *  - Stop trails at `atrMultiple` × ATR below the highest high (for LONG)
 *    or above the lowest low (for SHORT) since position entry
 *  - Only moves the stop in the direction of profit (never tightens against you)
 *
 * @param bars        Recent price bars (need at least 20; sorted oldest-first)
 * @param direction   "LONG" or "SHORT"
 * @param currentStop Current stop loss price
 * @param entryPrice  Position entry price
 * @param atrMultiple How many ATRs from the extreme to place the stop (default: 2.0)
 */
export const computeAtrTrailingStop = (
  bars: PriceBar[],
  direction: "LONG" | "SHORT",
  currentStop: number,
  entryPrice: number,
  atrMultiple = 2.0,
): TrailingStopResult => {
  if (bars.length < 15) {
    return { newStopLoss: currentStop, moved: false, distanceAtr: 0, atr: 0 };
  }

  // Compute ATR(14) using Wilder smoothing
  const period = 14;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  // Wilder-smoothed ATR
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  if (atr <= 0) return { newStopLoss: currentStop, moved: false, distanceAtr: 0, atr: 0 };

  const stopDistance = atrMultiple * atr;

  let newStop: number;
  if (direction === "LONG") {
    // Find highest high since entry
    const highestHigh = Math.max(...bars.map((b) => b.high));
    const candidateStop = highestHigh - stopDistance;
    // Only move stop UP (never back down)
    newStop = Math.max(candidateStop, currentStop);
  } else {
    // Find lowest low since entry
    const lowestLow = Math.min(...bars.map((b) => b.low));
    const candidateStop = lowestLow + stopDistance;
    // Only move stop DOWN (never back up)
    newStop = Math.min(candidateStop, currentStop);
  }

  const moved = Math.abs(newStop - currentStop) > atr * 0.05; // significant move threshold
  const distanceAtr = Math.abs(newStop - bars[bars.length - 1].close) / atr;

  return {
    newStopLoss: Number(newStop.toFixed(5)),
    moved,
    distanceAtr: Number(distanceAtr.toFixed(2)),
    atr: Number(atr.toFixed(5)),
  };
};

// ─── 3. Streak Risk Scaler ────────────────────────────────────────────────────

export interface StreakContext {
  /** Consecutive losses (positive number). Resets on a win. */
  consecutiveLosses: number;
  /** Consecutive wins (positive number). Resets on a loss. */
  consecutiveWins: number;
  /** Recent outcomes: true = win, false = loss (most recent last) */
  recentOutcomes: boolean[];
  /** Today's realized P&L as a fraction of account balance */
  dailyPnlPct: number;
}

export interface RiskScaleResult {
  scaledRiskPct: number;
  reason: string;
  scaleFactor: number;
}

/**
 * Scales risk per trade based on recent performance streaks.
 *
 * Cold streak: cut size to let the market "reset" before pressing again.
 * Hot streak: allow modest increase (but cap at 1.5× to avoid overconfidence).
 * Daily loss limit: auto-scales down as daily loss approaches the limit.
 */
export const computeStreakRiskScale = (
  baseRiskPct: number,
  ctx: StreakContext,
  maxDailyLossPct: number,
): RiskScaleResult => {
  let factor = 1.0;
  let reason = "Normal risk";

  // ── Daily loss guard ──────────────────────────────────────────────────────
  const dailyLossUsedFraction = Math.max(0, -ctx.dailyPnlPct) / maxDailyLossPct;
  if (dailyLossUsedFraction >= 0.9) {
    return { scaledRiskPct: 0, reason: "Daily loss limit reached — trading paused", scaleFactor: 0 };
  }
  if (dailyLossUsedFraction >= 0.6) {
    factor *= 0.5;
    reason = `Daily loss at ${(dailyLossUsedFraction * 100).toFixed(0)}% of limit — half size`;
  } else if (dailyLossUsedFraction >= 0.35) {
    factor *= 0.75;
    reason = `Daily loss at ${(dailyLossUsedFraction * 100).toFixed(0)}% of limit — reduced size`;
  }

  // ── Loss streak ───────────────────────────────────────────────────────────
  if (ctx.consecutiveLosses >= 4) {
    factor *= 0.25;
    reason = `${ctx.consecutiveLosses} consecutive losses — minimal size`;
  } else if (ctx.consecutiveLosses === 3) {
    factor *= 0.4;
    reason = "3 consecutive losses — significantly reduced";
  } else if (ctx.consecutiveLosses === 2) {
    factor *= 0.6;
    reason = "2 consecutive losses — reduced size";
  }

  // ── Win streak (modest press, capped) ─────────────────────────────────────
  if (ctx.consecutiveLosses === 0 && factor >= 1.0) {
    if (ctx.consecutiveWins >= 5) {
      factor = Math.min(factor * 1.4, 1.5);
      reason = `${ctx.consecutiveWins} consecutive wins — pressing with confidence`;
    } else if (ctx.consecutiveWins >= 3) {
      factor = Math.min(factor * 1.2, 1.35);
      reason = `${ctx.consecutiveWins} consecutive wins — modestly increased`;
    }
  }

  // ── Win rate check on last 10 trades ─────────────────────────────────────
  if (ctx.recentOutcomes.length >= 10) {
    const winRate = ctx.recentOutcomes.slice(-10).filter(Boolean).length / 10;
    if (winRate < 0.3 && factor > 0.5) {
      factor = Math.min(factor, 0.5);
      reason = `Win rate ${(winRate * 100).toFixed(0)}% over last 10 — caution mode`;
    }
  }

  const scaledRiskPct = Number(Math.max(0, Math.min(baseRiskPct * factor, baseRiskPct * 1.5)).toFixed(4));
  return { scaledRiskPct, reason, scaleFactor: Number(factor.toFixed(3)) };
};

// ─── 4. Multi-Timeframe Confluence Check ─────────────────────────────────────

export interface TimeframeSignal {
  timeframe: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strength: number; // 0-100
}

export interface ConfluenceResult {
  aligned: boolean;
  alignedCount: number;
  totalChecked: number;
  agreementPct: number;
  dominantDirection: "LONG" | "SHORT" | "NEUTRAL";
  reason: string;
}

/**
 * Checks whether signals on multiple timeframes agree.
 * Requires at least 60% of available timeframe signals to align
 * and at least 2 timeframes checked.
 */
export const checkMultiTimeframeConfluence = (
  signals: TimeframeSignal[],
  requiredDirection: "LONG" | "SHORT",
  minAlignedCount = 2,
  minAgreementPct = 0.6,
): ConfluenceResult => {
  const relevant = signals.filter((s) => s.direction !== "NEUTRAL");
  if (relevant.length < minAlignedCount) {
    return {
      aligned: false,
      alignedCount: 0,
      totalChecked: signals.length,
      agreementPct: 0,
      dominantDirection: "NEUTRAL",
      reason: `Only ${signals.length} timeframe(s) available — need at least ${minAlignedCount}`,
    };
  }

  const aligned = relevant.filter((s) => s.direction === requiredDirection);
  const agreementPct = aligned.length / relevant.length;
  const dominantDirection = agreementPct >= 0.5 ? requiredDirection : (requiredDirection === "LONG" ? "SHORT" : "LONG");

  return {
    aligned: agreementPct >= minAgreementPct && aligned.length >= minAlignedCount,
    alignedCount: aligned.length,
    totalChecked: relevant.length,
    agreementPct: Number(agreementPct.toFixed(3)),
    dominantDirection,
    reason: agreementPct >= minAgreementPct
      ? `${aligned.length}/${relevant.length} timeframes aligned ${requiredDirection}`
      : `Only ${aligned.length}/${relevant.length} timeframes aligned — insufficient confluence`,
  };
};

// ─── 5. Volatility-Adjusted Take Profit ──────────────────────────────────────

/**
 * Returns dynamic TP levels based on current ATR.
 * In high-volatility regimes, TP is extended; in low-vol, it's closer.
 *
 * This lets the system target realistic profits rather than fixed multiples.
 */
export const computeDynamicTakeProfit = (
  entry: number,
  stopLoss: number,
  direction: "LONG" | "SHORT",
  atr: number,
  volatilityClass: "low" | "medium" | "high" | "extreme",
): { takeProfit: number; riskReward: number; atrMultiple: number } => {
  const stopDistance = Math.abs(entry - stopLoss);

  // ATR multiple for TP based on volatility regime
  const atrMultipleMap: Record<typeof volatilityClass, number> = {
    low:     2.0,  // Tight markets: take profit early
    medium:  2.5,  // Standard: 2.5:1 R/R
    high:    3.0,  // Trending: let it run
    extreme: 2.0,  // Extreme vol: reduce TP (choppier price action)
  };

  const atrMultiple = atrMultipleMap[volatilityClass];
  const tpDistance = Math.max(stopDistance * 2.0, atr * atrMultiple);

  const takeProfit = direction === "LONG"
    ? entry + tpDistance
    : entry - tpDistance;

  const riskReward = tpDistance / Math.max(stopDistance, atr * 0.1);

  return {
    takeProfit: Number(takeProfit.toFixed(5)),
    riskReward: Number(riskReward.toFixed(2)),
    atrMultiple,
  };
};
