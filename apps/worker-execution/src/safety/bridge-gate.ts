import { evaluateBridgeGate } from "@stock-radar/core";
import { prisma } from "@stock-radar/db";
import type { BridgeHealthSnapshot } from "@stock-radar/types";

/**
 * Fetch the most-recent BridgeHealthSnapshot for an account and apply
 * the stale-bridge gate. Returns both the decision and the raw
 * staleness numbers so the caller can record them in RiskEvent / audit
 * logs on block.
 *
 * If the BridgeHealthSnapshot table has no row yet (phase-A backfill),
 * we treat the bridge as "unknown" and allow manage but block opens —
 * conservative by default. The Phase D bridge-health worker populates
 * this table every ~15s.
 */
export const checkAccountBridgeGate = async (accountId: string) => {
  const row = await (prisma as unknown as {
    bridgeHealthSnapshot?: {
      findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
    };
  }).bridgeHealthSnapshot?.findFirst?.({
    where: { accountId },
    orderBy: { capturedAt: "desc" },
  });

  if (!row) {
    return evaluateBridgeGate({ snapshot: null, now: new Date() });
  }

  const snapshot: BridgeHealthSnapshot = {
    accountId: String(row.accountId),
    integrationId: String(row.integrationId),
    bridgeHost: String(row.bridgeHost ?? ""),
    capturedAt: new Date(row.capturedAt as Date).toISOString(),
    status: row.status as BridgeHealthSnapshot["status"],
    terminalConnected: Boolean(row.terminalConnected),
    brokerConnected: Boolean(row.brokerConnected),
    accountLogin: (row.accountLogin as string | null) ?? null,
    server: (row.server as string | null) ?? null,
    pingMs: (row.pingMs as number | null) ?? null,
    lastOrderAckMs: (row.lastOrderAckMs as number | null) ?? null,
    lastPositionSyncMs: (row.lastPositionSyncMs as number | null) ?? null,
    lastHeartbeatAt: new Date(row.lastHeartbeatAt as Date).toISOString(),
    stalenessSeconds: Number(row.stalenessSeconds ?? 0),
    sdkVersion: (row.sdkVersion as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
  };

  return evaluateBridgeGate({ snapshot, now: new Date() });
};
