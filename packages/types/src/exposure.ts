import { z } from "zod";

/**
 * Aggregated exposure view across accounts for a single symbol or
 * correlation group. Produced by the portfolio manager and consumed
 * by allocator + UI.
 */
export const portfolioBucketKinds = ["SYMBOL", "CORRELATION_GROUP", "ASSET_CLASS"] as const;
export type PortfolioBucketKind = (typeof portfolioBucketKinds)[number];

export const portfolioBucketExposureSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(portfolioBucketKinds),
  bucketKey: z.string(), // ticker, correlation group name, or asset class
  asOf: z.string(),
  accountCount: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  netQuantityLong: z.number(),
  netQuantityShort: z.number(),
  netDirection: z.enum(["LONG", "SHORT", "FLAT", "HEDGED"]),
  grossRiskUsd: z.number(),
  netRiskUsd: z.number(),
  aggregateUnrealizedPnl: z.number(),
  aggregateExposurePct: z.number(),
  byAccount: z.array(
    z.object({
      accountId: z.string(),
      direction: z.enum(["LONG", "SHORT"]),
      quantity: z.number(),
      riskUsd: z.number(),
      exposurePct: z.number(),
      unrealizedPnl: z.number(),
    }),
  ),
});
export type PortfolioBucketExposure = z.infer<typeof portfolioBucketExposureSchema>;

/**
 * Firm-level rollup used by the global kill-switch and the UI
 * exposure pane.
 */
export const firmExposureSchema = z.object({
  asOf: z.string(),
  accountCount: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  totalGrossRiskUsd: z.number(),
  totalNetRiskUsd: z.number(),
  totalEquityUsd: z.number(),
  totalUnrealizedPnl: z.number(),
  totalRealizedPnlToday: z.number(),
  maxAccountDrawdownPct: z.number(),
  worstAccountId: z.string().nullable(),
  buckets: z.array(portfolioBucketExposureSchema),
});
export type FirmExposure = z.infer<typeof firmExposureSchema>;
