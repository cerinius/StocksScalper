import { describe, expect, it } from "vitest";
import { evaluateBridgeGate } from "./bridge-gate";

const freshSnapshot = (overrides: Partial<Parameters<typeof evaluateBridgeGate>[0]["snapshot"]> = {}) => ({
  accountId: "acc-1",
  integrationId: "int-1",
  bridgeHost: "localhost:8000",
  capturedAt: "2026-04-22T12:00:00.000Z",
  status: "CONNECTED" as const,
  terminalConnected: true,
  brokerConnected: true,
  accountLogin: "12345",
  server: "Broker-Demo",
  pingMs: 50,
  lastOrderAckMs: 120,
  lastPositionSyncMs: 60_000,
  lastHeartbeatAt: "2026-04-22T12:00:00.000Z",
  stalenessSeconds: 0,
  sdkVersion: "5.0.45",
  notes: null,
  ...overrides,
});

const now = new Date("2026-04-22T12:00:05.000Z"); // 5s after heartbeat

describe("evaluateBridgeGate", () => {
  it("blocks everything when no snapshot", () => {
    const r = evaluateBridgeGate({ snapshot: null, now });
    expect(r.allowOpen).toBe(false);
    expect(r.allowManage).toBe(false);
    expect(r.status).toBe("DISCONNECTED");
  });

  it("passes when bridge is fresh and connected", () => {
    const r = evaluateBridgeGate({ snapshot: freshSnapshot(), now });
    expect(r.allowOpen).toBe(true);
    expect(r.allowManage).toBe(true);
    expect(r.status).toBe("CONNECTED");
  });

  it("blocks opens when heartbeat is stale", () => {
    const stale = freshSnapshot({ lastHeartbeatAt: "2026-04-22T11:59:00.000Z" }); // 65s old
    const r = evaluateBridgeGate({ snapshot: stale, now });
    expect(r.allowOpen).toBe(false);
    expect(r.status).toBe("STALE");
  });

  it("blocks both open and manage when heartbeat is very old", () => {
    const veryStale = freshSnapshot({ lastHeartbeatAt: "2026-04-22T11:55:00.000Z" }); // 305s old > 4*30s
    const r = evaluateBridgeGate({ snapshot: veryStale, now });
    expect(r.allowOpen).toBe(false);
    expect(r.allowManage).toBe(false);
  });

  it("blocks opens when terminal disconnected", () => {
    const r = evaluateBridgeGate({ snapshot: freshSnapshot({ terminalConnected: false }), now });
    expect(r.allowOpen).toBe(false);
    expect(r.status).toBe("DISCONNECTED");
  });

  it("DEGRADED on high ping but still allows open", () => {
    const r = evaluateBridgeGate({ snapshot: freshSnapshot({ pingMs: 3_000 }), now });
    expect(r.status).toBe("DEGRADED");
    expect(r.allowOpen).toBe(true);
  });

  it("ERROR status forces block", () => {
    const r = evaluateBridgeGate({ snapshot: freshSnapshot({ status: "ERROR" }), now });
    expect(r.allowOpen).toBe(false);
    expect(r.status).toBe("ERROR");
  });
});
