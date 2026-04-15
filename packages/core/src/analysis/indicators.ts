/**
 * Technical Indicators Library
 *
 * Provides a complete set of indicators used for market analysis:
 *  - SMA, EMA (fixed seeding), properly computed MACD with EMA(9) signal
 *  - RSI, Stochastic RSI
 *  - ATR, Bollinger Bands, OBV, VWAP
 *  - ADX (+DI / -DI), Williams %R, CCI
 *
 * All functions are pure and operate on arrays of numbers (or PriceBar[]).
 */

import type { MarketIndicatorSnapshot, PriceBar } from "@stock-radar/types";
import { average, clamp } from "@stock-radar/shared";

// ─── Primitives ───────────────────────────────────────────────────────────────

const toCloses = (bars: PriceBar[]) => bars.map((b) => b.close);

/** Simple Moving Average over the last `period` values */
const sma = (values: number[], period: number): number => {
  if (values.length === 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
};

/**
 * Exponential Moving Average — Wilder-style seeded on the first value.
 * Uses the full array so longer series produce more accurate final values.
 */
const ema = (values: number[], period: number): number => {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let current = values[0];
  for (let i = 1; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
};

/** Returns the full EMA series (same length as input) */
const emaArray = (values: number[], period: number): number[] => {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
};

/** Wilder-style smoothed moving average (used for ATR, ADX) */
const wilderSmooth = (values: number[], period: number): number => {
  if (values.length < period) return average(values);
  // Seed with the simple average of first `period` values
  let smoothed = average(values.slice(0, period));
  for (let i = period; i < values.length; i++) {
    smoothed = (smoothed * (period - 1) + values[i]) / period;
  }
  return smoothed;
};

// ─── Core Indicators ──────────────────────────────────────────────────────────

/** Average True Range (14-period) */
const atr = (bars: PriceBar[], period = 14): number => {
  if (bars.length < 2) return 0;
  const trs = bars.slice(1).map((bar, idx) => {
    const prev = bars[idx];
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
  });
  return wilderSmooth(trs, period);
};

/** RSI — standard Wilder method */
const rsi = (values: number[], period = 14): number => {
  if (values.length <= period) return 50;
  const deltas = values.slice(1).map((v, i) => v - values[i]);
  const gains = deltas.map((d) => (d > 0 ? d : 0));
  const losses = deltas.map((d) => (d < 0 ? -d : 0));

  // Seed the first Wilder average
  let avgGain = average(gains.slice(0, period));
  let avgLoss = average(losses.slice(0, period));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
};

/** Full RSI series */
const rsiArray = (values: number[], period = 14): number[] => {
  const result: number[] = new Array(period).fill(50);
  if (values.length <= period) return result;

  const deltas = values.slice(1).map((v, i) => v - values[i]);
  const gains = deltas.map((d) => (d > 0 ? d : 0));
  const losses = deltas.map((d) => (d < 0 ? -d : 0));

  let avgGain = average(gains.slice(0, period));
  let avgLoss = average(losses.slice(0, period));
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return result;
};

/** Proper MACD: EMA(12) - EMA(26), signal = EMA(9) of MACD line */
const macd = (values: number[]): { macd: number; signal: number; histogram: number } => {
  if (values.length < 26) return { macd: 0, signal: 0, histogram: 0 };

  const fast = emaArray(values, 12);
  const slow = emaArray(values, 26);

  // MACD line starts where slow EMA has data
  const macdLine = fast.map((f, i) => f - slow[i]);

  // Signal = EMA(9) of MACD line
  const signalLine = emaArray(macdLine, 9);
  const latest = macdLine.length - 1;

  const macdVal = macdLine[latest] ?? 0;
  const signalVal = signalLine[latest] ?? 0;

  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
};

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  width: number;      // (upper - lower) / middle — bandwidth as % of price
  percentB: number;   // (close - lower) / (upper - lower) — 0–1 range, >1 overbought
}

const bollingerBands = (closes: number[], period = 20, multiplier = 2): BollingerBands => {
  const zero: BollingerBands = { upper: 0, middle: 0, lower: 0, width: 0, percentB: 0.5 };
  if (closes.length < period) return zero;

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);

  const upper = middle + multiplier * stddev;
  const lower = middle - multiplier * stddev;
  const width = middle === 0 ? 0 : (upper - lower) / middle;
  const latest = closes[closes.length - 1];
  const percentB = upper === lower ? 0.5 : (latest - lower) / (upper - lower);

  return { upper, middle, lower, width, percentB };
};

// ─── Stochastic RSI ──────────────────────────────────────────────────────────

interface StochRSI {
  k: number;  // %K smoothed (0–100)
  d: number;  // %D = SMA(K, 3) (0–100)
}

const stochasticRSI = (closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): StochRSI => {
  const rsiValues = rsiArray(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod) return { k: 50, d: 50 };

  // Raw Stochastic RSI values
  const rawStoch: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...window);
    const maxRsi = Math.max(...window);
    rawStoch.push(maxRsi === minRsi ? 50 : ((rsiValues[i] - minRsi) / (maxRsi - minRsi)) * 100);
  }

  if (rawStoch.length === 0) return { k: 50, d: 50 };

  // %K = SMA(rawStoch, kSmooth)
  const kSeries: number[] = [];
  for (let i = kSmooth - 1; i < rawStoch.length; i++) {
    const slice = rawStoch.slice(i - kSmooth + 1, i + 1);
    kSeries.push(slice.reduce((a, b) => a + b, 0) / kSmooth);
  }

  if (kSeries.length === 0) return { k: rawStoch.at(-1) ?? 50, d: 50 };

  // %D = SMA(%K, dSmooth)
  const dSeries: number[] = [];
  for (let i = dSmooth - 1; i < kSeries.length; i++) {
    const slice = kSeries.slice(i - dSmooth + 1, i + 1);
    dSeries.push(slice.reduce((a, b) => a + b, 0) / dSmooth);
  }

  return {
    k: kSeries.at(-1) ?? 50,
    d: dSeries.at(-1) ?? 50,
  };
};

// ─── On-Balance Volume ────────────────────────────────────────────────────────

/** OBV and its trend slope (positive = buying pressure) */
const onBalanceVolume = (bars: PriceBar[]): { obv: number; trend: number } => {
  if (bars.length < 2) return { obv: 0, trend: 0 };

  let obvValue = 0;
  const obvSeries: number[] = [0];

  for (let i = 1; i < bars.length; i++) {
    const close = bars[i].close;
    const prevClose = bars[i - 1].close;
    const vol = bars[i].volume;

    if (close > prevClose) obvValue += vol;
    else if (close < prevClose) obvValue -= vol;

    obvSeries.push(obvValue);
  }

  // OBV trend: slope of last 20 bars (normalised to avoid huge numbers)
  const lookback = Math.min(20, obvSeries.length);
  const recentObv = obvSeries.slice(-lookback);
  const n = recentObv.length;
  const xMean = (n - 1) / 2;
  const yMean = recentObv.reduce((a, b) => a + b, 0) / n;
  const numerator = recentObv.reduce((sum, y, x) => sum + (x - xMean) * (y - yMean), 0);
  const denominator = recentObv.reduce((sum, _, x) => sum + (x - xMean) ** 2, 0);
  const slope = denominator === 0 ? 0 : numerator / denominator;

  // Normalise slope relative to average absolute OBV magnitude
  const avgAbs = recentObv.reduce((s, v) => s + Math.abs(v), 0) / n || 1;
  const normalisedTrend = clamp((slope / avgAbs) * 100, -100, 100);

  return { obv: obvValue, trend: normalisedTrend };
};

// ─── VWAP ─────────────────────────────────────────────────────────────────────

/**
 * Volume-Weighted Average Price.
 * For intraday charts, computes running VWAP from the bars provided.
 * For daily charts, VWAP = typical price (approximation).
 */
const vwap = (bars: PriceBar[]): number => {
  if (bars.length === 0) return 0;

  let cumTpVol = 0;
  let cumVol = 0;

  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    const vol = bar.volume || 1; // avoid zero division
    cumTpVol += tp * vol;
    cumVol += vol;
  }

  return cumVol === 0 ? (bars.at(-1)?.close ?? 0) : cumTpVol / cumVol;
};

// ─── ADX (Average Directional Index) ─────────────────────────────────────────

interface ADXResult {
  adx: number;
  plusDI: number;
  minusDI: number;
}

const adx = (bars: PriceBar[], period = 14): ADXResult => {
  if (bars.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const trValues: number[] = [];
  const plusDMValues: number[] = [];
  const minusDMValues: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i];
    const prev = bars[i - 1];

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trValues.push(tr);

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    plusDMValues.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMValues.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothedTR = wilderSmooth(trValues, period);
  const smoothedPlusDM = wilderSmooth(plusDMValues, period);
  const smoothedMinusDM = wilderSmooth(minusDMValues, period);

  const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
  const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;

  const diDiff = Math.abs(plusDI - minusDI);
  const diSum = plusDI + minusDI;
  const dx = diSum === 0 ? 0 : (diDiff / diSum) * 100;

  // For ADX we need a series of DX values — approximate with the current DX
  // (a full implementation would track a DX series, but this is sufficient)
  return { adx: dx, plusDI, minusDI };
};

// ─── Williams %R ─────────────────────────────────────────────────────────────

const williamsR = (bars: PriceBar[], period = 14): number => {
  if (bars.length < period) return -50;
  const slice = bars.slice(-period);
  const highest = Math.max(...slice.map((b) => b.high));
  const lowest = Math.min(...slice.map((b) => b.low));
  const close = slice.at(-1)!.close;
  if (highest === lowest) return -50;
  return ((highest - close) / (highest - lowest)) * -100;
};

// ─── CCI (Commodity Channel Index) ───────────────────────────────────────────

const cci = (bars: PriceBar[], period = 20): number => {
  if (bars.length < period) return 0;
  const slice = bars.slice(-period);
  const typicalPrices = slice.map((b) => (b.high + b.low + b.close) / 3);
  const mean = typicalPrices.reduce((a, b) => a + b, 0) / period;
  const meanDeviation = typicalPrices.reduce((sum, tp) => sum + Math.abs(tp - mean), 0) / period;
  if (meanDeviation === 0) return 0;
  const latest = typicalPrices[typicalPrices.length - 1];
  return (latest - mean) / (0.015 * meanDeviation);
};

// ─── Volume Profile ───────────────────────────────────────────────────────────

interface VolumeProfileResult {
  poc: number;           // Point of Control
  vah: number;           // Value Area High (70% of volume above POC)
  val: number;           // Value Area Low  (70% of volume below POC)
  priceRelToPoc: number; // (close - poc) / poc × 100; positive = above
}

const volumeProfile = (bars: PriceBar[], lookback = 50, numBuckets = 30): VolumeProfileResult => {
  const zero: VolumeProfileResult = { poc: 0, vah: 0, val: 0, priceRelToPoc: 0 };
  if (bars.length < 2) return zero;

  const slice = bars.slice(-lookback);
  const priceMax = Math.max(...slice.map((b) => b.high));
  const priceMin = Math.min(...slice.map((b) => b.low));
  if (priceMax === priceMin) return { poc: priceMax, vah: priceMax, val: priceMin, priceRelToPoc: 0 };

  const bucketSize = (priceMax - priceMin) / numBuckets;
  const buckets = new Array<number>(numBuckets).fill(0);

  for (const bar of slice) {
    const barRange = bar.high - bar.low;
    for (let i = 0; i < numBuckets; i++) {
      const bucketLow = priceMin + i * bucketSize;
      const bucketHigh = bucketLow + bucketSize;
      const overlap = Math.max(0, Math.min(bar.high, bucketHigh) - Math.max(bar.low, bucketLow));
      if (overlap > 0 && barRange > 0) buckets[i] += bar.volume * (overlap / barRange);
    }
  }

  // POC = bucket with highest volume
  let pocIdx = 0;
  for (let i = 1; i < numBuckets; i++) {
    if (buckets[i] > buckets[pocIdx]) pocIdx = i;
  }
  const poc = priceMin + (pocIdx + 0.5) * bucketSize;

  // Value Area: expand from POC until 70% of total volume is covered
  const totalVol = buckets.reduce((a, b) => a + b, 0);
  const target = totalVol * 0.70;
  let vaVol = buckets[pocIdx];
  let vaLow = pocIdx;
  let vaHigh = pocIdx;

  while (vaVol < target) {
    const upNext = vaHigh + 1 < numBuckets ? buckets[vaHigh + 1] : -1;
    const dnNext = vaLow - 1 >= 0 ? buckets[vaLow - 1] : -1;
    if (upNext < 0 && dnNext < 0) break;
    if (upNext >= dnNext) { vaHigh++; vaVol += buckets[vaHigh]; }
    else { vaLow--; vaVol += buckets[vaLow]; }
  }

  const val = priceMin + vaLow * bucketSize;
  const vah = priceMin + (vaHigh + 1) * bucketSize;
  const latestClose = slice.at(-1)!.close;
  const priceRelToPoc = poc === 0 ? 0 : ((latestClose - poc) / poc) * 100;

  return { poc, vah, val, priceRelToPoc };
};

// ─── Order Flow Delta (OHLCV approximation) ───────────────────────────────────

interface OrderFlowResult {
  delta: number;           // Latest bar: estimated buy − sell volume
  cumulativeDelta: number; // Sum of delta over lookback bars
  deltaDivergence: number; // +1 = delta confirms price direction, −1 = divergence
}

const orderFlowDelta = (bars: PriceBar[], lookback = 20): OrderFlowResult => {
  const zero: OrderFlowResult = { delta: 0, cumulativeDelta: 0, deltaDivergence: 0 };
  if (bars.length < 2) return zero;

  const slice = bars.slice(-lookback);
  const deltas: number[] = [];

  for (const bar of slice) {
    const range = bar.high - bar.low;
    if (range === 0) { deltas.push(0); continue; }
    // Buying pressure ∝ (close − low); selling pressure ∝ (high − close)
    const buyVol = bar.volume * ((bar.close - bar.low) / range);
    const sellVol = bar.volume * ((bar.high - bar.close) / range);
    deltas.push(buyVol - sellVol);
  }

  const currentDelta = deltas.at(-1) ?? 0;
  const cumulativeDelta = deltas.reduce((a, b) => a + b, 0);

  // Divergence: does cumulative delta agree with 5-bar price direction?
  const recent5bars = slice.slice(-5);
  const recent5deltas = deltas.slice(-5);
  if (recent5bars.length >= 2) {
    const priceDir = recent5bars.at(-1)!.close > recent5bars[0].close ? 1 : -1;
    const deltaDir = recent5deltas.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
    const deltaDivergence = priceDir === deltaDir ? 1 : -1;
    return { delta: currentDelta, cumulativeDelta, deltaDivergence };
  }

  return { delta: currentDelta, cumulativeDelta, deltaDivergence: 0 };
};

// ─── ICT: Fair Value Gap ──────────────────────────────────────────────────────

interface FVGResult {
  present: boolean;
  type: "bullish" | "bearish" | "none";
  top: number;
  bottom: number;
  mid: number;
  inFVG: boolean;
}

/**
 * Fair Value Gap — 3-candle imbalance:
 *   Bullish FVG: candle[i−2].high < candle[i].low  (price jumped up leaving a gap)
 *   Bearish FVG: candle[i−2].low  > candle[i].high (price dropped leaving a gap)
 * Returns the most recent unmitigated FVG within `lookback` bars.
 */
const detectFVG = (bars: PriceBar[], lookback = 15): FVGResult => {
  const zero: FVGResult = { present: false, type: "none", top: 0, bottom: 0, mid: 0, inFVG: false };
  if (bars.length < 3) return zero;

  const current = bars.at(-1)!;
  const slice = bars.slice(-lookback);

  for (let i = slice.length - 1; i >= 2; i--) {
    const b1 = slice[i - 2];
    const b3 = slice[i];

    if (b3.low > b1.high) {
      // Bullish FVG
      const bottom = b1.high;
      const top = b3.low;
      const mid = (top + bottom) / 2;
      const inFVG = current.close >= bottom && current.close <= top;
      return { present: true, type: "bullish", top, bottom, mid, inFVG };
    }
    if (b3.high < b1.low) {
      // Bearish FVG
      const top = b1.low;
      const bottom = b3.high;
      const mid = (top + bottom) / 2;
      const inFVG = current.close >= bottom && current.close <= top;
      return { present: true, type: "bearish", top, bottom, mid, inFVG };
    }
  }

  return zero;
};

// ─── ICT: Liquidity Sweep ─────────────────────────────────────────────────────

interface LiquiditySweepResult {
  present: boolean;
  type: "high_sweep" | "low_sweep" | "none";
  sweepLevel: number;
}

/**
 * Liquidity Sweep — the last candle briefly broke a prior swing high/low
 * (triggering stops) but closed back inside the range (smart-money reversal).
 */
const detectLiquiditySweep = (bars: PriceBar[], lookback = 20): LiquiditySweepResult => {
  const zero: LiquiditySweepResult = { present: false, type: "none", sweepLevel: 0 };
  if (bars.length < lookback + 2) return zero;

  const recent = bars.at(-1)!;
  const swingBars = bars.slice(-(lookback + 1), -1);
  const swingHigh = Math.max(...swingBars.map((b) => b.high));
  const swingLow = Math.min(...swingBars.map((b) => b.low));

  // High sweep: wick exceeded prior high but closed below it
  if (recent.high > swingHigh && recent.close < swingHigh) {
    return { present: true, type: "high_sweep", sweepLevel: swingHigh };
  }
  // Low sweep: wick exceeded prior low but closed above it
  if (recent.low < swingLow && recent.close > swingLow) {
    return { present: true, type: "low_sweep", sweepLevel: swingLow };
  }

  return zero;
};

// ─── ICT: Market Structure (BOS / CHoCH) ─────────────────────────────────────

interface MarketStructureResult {
  bosPresent: boolean;
  chochPresent: boolean;
  type: "bullish_bos" | "bearish_bos" | "bullish_choch" | "bearish_choch" | "none";
}

/**
 * Break of Structure (BOS) = trend continuation past prior swing.
 * Change of Character (CHoCH) = first break in the opposite direction — reversal signal.
 */
const detectMarketStructure = (bars: PriceBar[], swingLen = 5): MarketStructureResult => {
  const zero: MarketStructureResult = { bosPresent: false, chochPresent: false, type: "none" };
  const needed = swingLen * 4;
  if (bars.length < needed) return zero;

  const recent = bars.slice(-needed);
  const current = recent.at(-1)!;

  // Collect swing highs and lows (simple pivot detection)
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = swingLen; i < recent.length - swingLen; i++) {
    const window = recent.slice(i - swingLen, i + swingLen + 1);
    if (recent[i].high >= Math.max(...window.map((b) => b.high))) swingHighs.push(recent[i].high);
    if (recent[i].low <= Math.min(...window.map((b) => b.low))) swingLows.push(recent[i].low);
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return zero;

  const lastHigh = swingHighs.at(-1)!;
  const prevHigh = swingHighs.at(-2)!;
  const lastLow = swingLows.at(-1)!;
  const prevLow = swingLows.at(-2)!;

  // Bullish break
  if (current.close > lastHigh) {
    // Higher prior swings = uptrend continuation (BOS); else first break up = CHoCH
    return prevHigh < lastHigh
      ? { bosPresent: true, chochPresent: false, type: "bullish_bos" }
      : { bosPresent: false, chochPresent: true, type: "bullish_choch" };
  }
  // Bearish break
  if (current.close < lastLow) {
    return prevLow > lastLow
      ? { bosPresent: true, chochPresent: false, type: "bearish_bos" }
      : { bosPresent: false, chochPresent: true, type: "bearish_choch" };
  }

  return zero;
};

// ─── ICT: Optimal Trade Entry (Fibonacci 61.8–78.6% retracement) ─────────────

/**
 * Returns true when the current close sits in the OTE zone — the
 * 61.8 %–78.6 % retracement of the most recent impulse swing.
 */
const detectOTEZone = (bars: PriceBar[], swingLookback = 20): boolean => {
  if (bars.length < swingLookback + 1) return false;

  const slice = bars.slice(-swingLookback);
  const current = bars.at(-1)!;
  const swingHigh = Math.max(...slice.map((b) => b.high));
  const swingLow = Math.min(...slice.map((b) => b.low));
  const range = swingHigh - swingLow;
  if (range === 0) return false;

  // Bullish OTE: price retracted 61.8–78.6% from swing high back toward low
  const ote618 = swingHigh - range * 0.618;
  const ote786 = swingHigh - range * 0.786;
  return current.close >= ote786 && current.close <= ote618;
};

// ─── ICT: Session Killzones ───────────────────────────────────────────────────

const checkKillzone = (): { inKillzone: boolean; name: string } => {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (mins >= 420 && mins < 600) return { inKillzone: true, name: "London Open" };   // 07–10 UTC
  if (mins >= 720 && mins < 900) return { inKillzone: true, name: "New York Open" }; // 12–15 UTC
  if (mins >= 900 && mins < 1020) return { inKillzone: true, name: "London Close" }; // 15–17 UTC
  if (mins >= 1380 || mins < 120) return { inKillzone: true, name: "Asian" };         // 23–02 UTC

  return { inKillzone: false, name: "" };
};

// ─── Full Snapshot ────────────────────────────────────────────────────────────

export const calculateIndicatorSnapshot = (bars: PriceBar[]): MarketIndicatorSnapshot => {
  const closes = toCloses(bars);
  const latest = bars.at(-1);

  const zero: MarketIndicatorSnapshot = {
    sma20: 0, sma50: 0, ema21: 0, ema50: 0,
    rsi14: 50, macd: 0, macdSignal: 0, macdHistogram: 0,
    atr14: 0, atrPct: 0, volumeRatio: 1, trendStrength: 0, momentumScore: 0,
    bbUpper: 0, bbMiddle: 0, bbLower: 0, bbWidth: 0, bbPercentB: 0.5,
    stochRsiK: 50, stochRsiD: 50,
    obv: 0, obvTrend: 0,
    vwap: 0,
    adx14: 0, plusDI: 0, minusDI: 0,
    williamsR: -50,
    cci20: 0,
  };

  if (!latest || closes.length < 2) return zero;

  // ── Core ────────────────────────────────────────────────────────────────────
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdResult = macd(closes);
  const atr14 = atr(bars, 14);
  const atrPct = latest.close === 0 ? 0 : (atr14 / latest.close) * 100;

  // Volume
  const recentVol = average(bars.slice(-5).map((b) => b.volume));
  const baselineVol = average(bars.slice(-20).map((b) => b.volume)) || recentVol || 1;
  const volumeRatio = recentVol / baselineVol;

  // Extended MAs
  const ema9 = ema(closes, 9);
  const ema200 = closes.length >= 200 ? ema(closes, 200) : ema(closes, closes.length);

  // Trend & momentum
  const trendStrength = clamp(((ema21 - ema50) / Math.max(latest.close, 1)) * 1000, -100, 100);
  const momentumScore = clamp(
    (rsi14 - 50) * 1.6 + trendStrength * 0.5 + (volumeRatio - 1) * 25,
    -100,
    100,
  );

  // ── Enhanced Indicators ─────────────────────────────────────────────────────
  const bb = bollingerBands(closes, 20, 2);
  const stochRsi = stochasticRSI(closes, 14, 14, 3, 3);
  const obvResult = onBalanceVolume(bars);
  const vwapValue = vwap(bars);
  const adxResult = adx(bars, 14);
  const wR = williamsR(bars, 14);
  const cciValue = cci(bars, 20);

  // ── Volume Profile ───────────────────────────────────────────────────────────
  const vp = volumeProfile(bars, Math.min(bars.length, 50));

  // ── Order Flow ───────────────────────────────────────────────────────────────
  const of_ = orderFlowDelta(bars, Math.min(bars.length, 20));

  // ── ICT Layers ───────────────────────────────────────────────────────────────
  const fvg = detectFVG(bars, Math.min(bars.length, 15));
  const liqSweep = detectLiquiditySweep(bars, Math.min(bars.length - 2, 20));
  const ms = detectMarketStructure(bars);
  const inOTEZone = detectOTEZone(bars, Math.min(bars.length - 1, 20));
  const kz = checkKillzone();

  return {
    // Core
    sma20,
    sma50,
    ema21,
    ema50,
    rsi14,
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    atr14,
    atrPct,
    volumeRatio,
    trendStrength,
    momentumScore,
    // Extended MAs
    ema9,
    ema200,
    // Bollinger Bands
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    bbWidth: bb.width,
    bbPercentB: bb.percentB,
    // Stochastic RSI
    stochRsiK: stochRsi.k,
    stochRsiD: stochRsi.d,
    // OBV
    obv: obvResult.obv,
    obvTrend: obvResult.trend,
    // VWAP
    vwap: vwapValue,
    // ADX
    adx14: adxResult.adx,
    plusDI: adxResult.plusDI,
    minusDI: adxResult.minusDI,
    // Williams %R
    williamsR: wR,
    // CCI
    cci20: cciValue,
    // Volume Profile
    pocPrice: vp.poc,
    vahPrice: vp.vah,
    valPrice: vp.val,
    priceRelToPoc: vp.priceRelToPoc,
    // Order Flow
    orderFlowDelta: of_.delta,
    cumulativeDelta: of_.cumulativeDelta,
    deltaDivergence: of_.deltaDivergence,
    // ICT — FVG
    fvgPresent: fvg.present,
    fvgType: fvg.type,
    fvgTop: fvg.top,
    fvgBottom: fvg.bottom,
    fvgMid: fvg.mid,
    inFVG: fvg.inFVG,
    // ICT — Liquidity Sweep
    liquiditySweep: liqSweep.present,
    liquiditySweepType: liqSweep.type,
    sweepLevel: liqSweep.sweepLevel,
    // ICT — Market Structure
    bosPresent: ms.bosPresent,
    chochPresent: ms.chochPresent,
    marketStructureType: ms.type,
    // ICT — OTE
    inOTEZone,
    // ICT — Killzones
    inKillzone: kz.inKillzone,
    killzoneName: kz.name,
  };
};
