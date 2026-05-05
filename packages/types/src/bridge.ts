import { z } from "zod";

/**
 * Health status of a single MT5 bridge endpoint (Windows host running
 * the Python FastAPI + MetaTrader5 SDK).
 */
export const bridgeHealthStatuses = [
  "CONNECTED",
  "DEGRADED",
  "STALE",
  "DISCONNECTED",
  "ERROR",
] as const;
export type BridgeHealthStatus = (typeof bridgeHealthStatuses)[number];

export const bridgeHealthSnapshotSchema = z.object({
  id: z.string().optional(),
  accountId: z.string(), // each account has its own bridge binding
  integrationId: z.string(),
  bridgeHost: z.string(), // e.g. "mt5-bridge.local:8000"
  capturedAt: z.string(),
  status: z.enum(bridgeHealthStatuses),
  terminalConnected: z.boolean(),
  brokerConnected: z.boolean(),
  accountLogin: z.string().nullable(),
  server: z.string().nullable(),
  pingMs: z.number().int().nonnegative().nullable(),
  lastOrderAckMs: z.number().int().nonnegative().nullable(),
  lastPositionSyncMs: z.number().int().nonnegative().nullable(),
  lastHeartbeatAt: z.string(),
  stalenessSeconds: z.number().int().nonnegative(),
  sdkVersion: z.string().nullable(),
  notes: z.string().nullable(),
});
export type BridgeHealthSnapshot = z.infer<typeof bridgeHealthSnapshotSchema>;

/**
 * Staleness rules used by the stale-bridge gate. Any of these being
 * true blocks new order placement for that account.
 */
export const bridgeStaleThresholds = {
  lastHeartbeatSeconds: 30,
  lastPositionSyncSeconds: 120,
  maxPingMs: 2000,
} as const;
export type BridgeStaleThresholds = typeof bridgeStaleThresholds;
