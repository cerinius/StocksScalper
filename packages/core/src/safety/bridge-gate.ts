import {
  bridgeStaleThresholds,
  type BridgeHealthSnapshot,
  type BridgeHealthStatus,
  type BridgeStaleThresholds,
} from "@stock-radar/types";

/**
 * Outcome of the bridge-gate evaluation. `allowOpen=false` means the
 * worker must not place new orders on this account; it may still
 * attempt to manage or close existing positions if the bridge is
 * reachable enough to send those commands.
 */
export interface BridgeGateDecision {
  allowOpen: boolean;
  allowManage: boolean;
  status: BridgeHealthStatus;
  reasons: string[];
  staleness: {
    heartbeatSeconds: number;
    positionSyncSeconds: number | null;
    pingMs: number | null;
  };
}

export interface EvaluateBridgeGateInputs {
  snapshot: BridgeHealthSnapshot | null;
  now: Date;
  thresholds?: BridgeStaleThresholds;
}

const secondsBetween = (from: string, to: Date): number => {
  const fromMs = new Date(from).getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((toMs - fromMs) / 1_000));
};

/**
 * Deterministic stale-bridge gate. Pure function — no side effects.
 *
 * Decision table:
 * - No snapshot at all → DISCONNECTED, block both open and manage
 * - Terminal or broker not connected → DISCONNECTED, block open, allow
 *   manage only if heartbeat is fresh (we still try to close/flatten).
 * - Any threshold breached → STALE, block open, allow manage.
 * - Ping over max → DEGRADED, allow open but warn.
 * - Otherwise → CONNECTED.
 */
export const evaluateBridgeGate = (inputs: EvaluateBridgeGateInputs): BridgeGateDecision => {
  const thresholds = inputs.thresholds ?? bridgeStaleThresholds;
  const reasons: string[] = [];

  if (!inputs.snapshot) {
    return {
      allowOpen: false,
      allowManage: false,
      status: "DISCONNECTED",
      reasons: ["No bridge health snapshot available."],
      staleness: {
        heartbeatSeconds: Number.POSITIVE_INFINITY,
        positionSyncSeconds: null,
        pingMs: null,
      },
    };
  }

  const heartbeatSeconds = secondsBetween(inputs.snapshot.lastHeartbeatAt, inputs.now);
  const positionSyncSeconds = inputs.snapshot.lastPositionSyncMs == null
    ? null
    : Math.max(0, Math.floor(inputs.snapshot.lastPositionSyncMs / 1_000));
  const pingMs = inputs.snapshot.pingMs;

  let status: BridgeHealthStatus = "CONNECTED";
  let allowOpen = true;
  let allowManage = true;

  if (!inputs.snapshot.terminalConnected) {
    reasons.push("MT5 terminal not connected.");
    status = "DISCONNECTED";
    allowOpen = false;
  }
  if (!inputs.snapshot.brokerConnected) {
    reasons.push("Broker session not connected.");
    status = "DISCONNECTED";
    allowOpen = false;
  }

  if (heartbeatSeconds > thresholds.lastHeartbeatSeconds) {
    reasons.push(
      `Heartbeat is ${heartbeatSeconds}s old, threshold ${thresholds.lastHeartbeatSeconds}s.`,
    );
    status = status === "DISCONNECTED" ? "DISCONNECTED" : "STALE";
    allowOpen = false;
    if (heartbeatSeconds > thresholds.lastHeartbeatSeconds * 4) {
      allowManage = false;
    }
  }

  if (
    positionSyncSeconds !== null &&
    positionSyncSeconds > thresholds.lastPositionSyncSeconds
  ) {
    reasons.push(
      `Position sync is ${positionSyncSeconds}s old, threshold ${thresholds.lastPositionSyncSeconds}s.`,
    );
    status = status === "DISCONNECTED" ? "DISCONNECTED" : "STALE";
    allowOpen = false;
  }

  if (pingMs !== null && pingMs > thresholds.maxPingMs) {
    reasons.push(`Ping ${pingMs}ms exceeds ${thresholds.maxPingMs}ms budget.`);
    if (status === "CONNECTED") status = "DEGRADED";
    // Degraded ping does NOT hard-block opens, but rule evaluator may
    // still downgrade the account to CAUTIOUS via a separate signal.
  }

  // Explicit provider-reported status always wins for the rollup.
  if (inputs.snapshot.status === "ERROR") {
    status = "ERROR";
    allowOpen = false;
    reasons.push("Bridge reported ERROR status.");
  }

  return {
    allowOpen,
    allowManage,
    status,
    reasons,
    staleness: {
      heartbeatSeconds,
      positionSyncSeconds,
      pingMs,
    },
  };
};
