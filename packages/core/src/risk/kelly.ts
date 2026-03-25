import { clamp } from "@stock-radar/shared";

export interface KellySizingInput {
  winRateEstimate: number | null | undefined;
  riskReward: number;
  confidenceScore?: number | null;
}

export const calculateHalfKellyMultiplier = ({ winRateEstimate, riskReward, confidenceScore }: KellySizingInput) => {
  if (!winRateEstimate || riskReward <= 0) {
    return 0.5;
  }

  const p = clamp(winRateEstimate, 0.01, 0.99);
  const q = 1 - p;
  const b = Math.max(riskReward, 0.05);
  const rawKelly = p - q / b;
  if (!Number.isFinite(rawKelly) || rawKelly <= 0) {
    return 0.25;
  }

  const halfKelly = rawKelly / 2;
  const confidenceThrottle = clamp((confidenceScore ?? 60) / 100, 0.45, 1);
  return clamp(halfKelly * confidenceThrottle * 2, 0.25, 1);
};
