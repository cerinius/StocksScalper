import type { MarketIndicatorSnapshot, PriceBar } from "@stock-radar/types";
import { average, clamp } from "@stock-radar/shared";

const toCloses = (bars: PriceBar[]) => bars.map((bar) => bar.close);

const sma = (values: number[], period: number) => {
  if (values.length === 0) return 0;
  return average(values.slice(-period));
};

const ema = (values: number[], period: number) => {
  if (values.length === 0) return 0;
  const multiplier = 2 / (period + 1);
  return values.reduce((current, value) => value * multiplier + current * (1 - multiplier), values[0]);
};

const atr = (bars: PriceBar[], period: number) => {
  if (bars.length < 2) return 0;
  const trueRanges = bars.slice(1).map((bar, index) => {
    const previous = bars[index];
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
  });
  return average(trueRanges.slice(-period));
};

const rsi = (values: number[], period: number) => {
  if (values.length <= period) return 50;
  const deltas = values.slice(1).map((value, index) => value - values[index]);
  const gains = deltas.map((delta) => (delta > 0 ? delta : 0));
  const losses = deltas.map((delta) => (delta < 0 ? Math.abs(delta) : 0));
  const avgGain = average(gains.slice(-period));
  const avgLoss = average(losses.slice(-period));
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
};

const macd = (values: number[]) => {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = fast - slow;
  return {
    macd: line,
    signal: line * 0.8,
  };
};

export const calculateIndicatorSnapshot = (bars: PriceBar[]): MarketIndicatorSnapshot => {
  const closes = toCloses(bars);
  const latest = bars.at(-1);

  if (!latest) {
    return {
      sma20: 0,
      sma50: 0,
      ema21: 0,
      ema50: 0,
      rsi14: 50,
      macd: 0,
      macdSignal: 0,
      atr14: 0,
      atrPct: 0,
      volumeRatio: 1,
      trendStrength: 0,
      momentumScore: 0,
    };
  }

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdValues = macd(closes);
  const atr14 = atr(bars, 14);
  const atrPct = latest.close === 0 ? 0 : (atr14 / latest.close) * 100;
  const recentVolume = average(bars.slice(-5).map((bar) => bar.volume));
  const baselineVolume = average(bars.slice(-20).map((bar) => bar.volume)) || recentVolume || 1;
  const volumeRatio = recentVolume / baselineVolume;
  const trendStrength = clamp(((ema21 - ema50) / Math.max(latest.close, 1)) * 1000, -100, 100);
  const momentumScore = clamp((rsi14 - 50) * 1.6 + trendStrength * 0.5 + (volumeRatio - 1) * 25, -100, 100);

  return {
    sma20,
    sma50,
    ema21,
    ema50,
    rsi14,
    macd: macdValues.macd,
    macdSignal: macdValues.signal,
    atr14,
    atrPct,
    volumeRatio,
    trendStrength,
    momentumScore,
  };
};
