import Fastify from "fastify";
import { getPlatformConfig } from "@stock-radar/config";
import { createLogger } from "@stock-radar/logging";
import { mt5ConnectRequestSchema, mt5OrderRequestSchema } from "@stock-radar/types";
import { stableHash } from "@stock-radar/shared";

const config = getPlatformConfig();
const logger = createLogger("mt5-adapter");
const app = Fastify({ logger: false });

const mt5BridgeUrl = process.env.MT5_BRIDGE_URL?.replace(/\/+$|$/, "") || "";
const useLiveBridge = mt5BridgeUrl.length > 0;
const mt5BridgeAuthToken = process.env.MT5_BRIDGE_AUTH_TOKEN?.trim() ?? "";
const paperBrokerAutoConnect =
  process.env.PAPER_BROKER_AUTO_CONNECT?.toLowerCase() === "true" ||
  (!useLiveBridge && config.trading.mode === "paper");

/**
 * Multi-node bridge registry: maps accountId → bridge URL.
 * Populated from MT5_BRIDGE_NODES env var (JSON array):
 *   [{"accountId":"acc_123","url":"http://192.168.1.42:8000"}]
 * Falls back to the single MT5_BRIDGE_URL for all accounts if not set.
 */
const parseBridgeNodes = (): Map<string, string> => {
  const nodes = new Map<string, string>();
  try {
    const raw = process.env.MT5_BRIDGE_NODES;
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ accountId: string; url: string }>;
      for (const node of parsed) {
        if (node.accountId && node.url) {
          nodes.set(node.accountId, node.url.replace(/\/+$/, ""));
        }
      }
    }
  } catch {
    logger.warn("Failed to parse MT5_BRIDGE_NODES — falling back to MT5_BRIDGE_URL");
  }
  return nodes;
};
const bridgeNodes = parseBridgeNodes();

/**
 * Resolve the bridge URL for a given accountId.
 * Falls back to the global MT5_BRIDGE_URL if no per-account mapping exists.
 */
const resolveBridgeUrlForAccount = (accountId: string | null): string => {
  if (accountId && bridgeNodes.has(accountId)) return bridgeNodes.get(accountId)!;
  return mt5BridgeUrl;
};

/**
 * Mock fallback guard.
 * In funded/live mode, mock fallback is NEVER allowed regardless of the env flag.
 * In paper mode, mock fallback is allowed unless explicitly disabled.
 */
const ALLOW_MOCK_FALLBACK_ENV = process.env.BRIDGE_ALLOW_MOCK_FALLBACK?.toLowerCase() !== "false";
const isMockFallbackAllowed = (accountPhase?: string): boolean => {
  if (config.trading.mode === "live") return false;
  if (accountPhase === "FUNDED" || accountPhase === "PAYOUT_PROTECT" || accountPhase === "SCALE_UP") return false;
  return ALLOW_MOCK_FALLBACK_ENV;
};

console.log('MT5_BRIDGE_URL:', process.env.MT5_BRIDGE_URL, 'mt5BridgeUrl:', mt5BridgeUrl, 'useLiveBridge:', useLiveBridge);

const proxyToBridge = async (
  path: string,
  method: string = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown; bridgeError?: string }> => {
  if (!useLiveBridge) {
    return { status: 503, data: { error: "MT5_BRIDGE_URL is not configured. Set it to your Python bridge URL." }, bridgeError: "not_configured" };
  }

  const url = `${mt5BridgeUrl}${path}`;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    };
    if (mt5BridgeAuthToken.length > 0) {
      headers.Authorization = `Bearer ${mt5BridgeAuthToken}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000), // 8s timeout
    });

    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { status: response.status, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("MT5 bridge unreachable", { path, error: msg });
    return {
      status: 503,
      data: { error: `MT5 bridge unreachable: ${msg}. Ensure integrations/mt5-bridge/run.ps1 is running on your Windows machine.` },
      bridgeError: msg,
    };
  }
};

const state = {
  connected: paperBrokerAutoConnect,
  mode: config.trading.mode,
  lastSyncAt: new Date().toISOString(),
  account: {
    balance: 100_000,    // OxSecurities Demo: Ekjot Singh, Account 1114231
    equity: 100_000,
    freeMargin: 100_000,
    usedMargin: 0,
    openPnl: 0,
    realizedPnlDaily: 0,
    drawdownPct: 0,
    maxDrawdownPct: 2.5,
    riskState: "NORMAL" as const,
    killSwitchActive: false,
    mode: config.trading.mode,
  },
  orders: [] as Array<Record<string, unknown>>,
  positions: [] as Array<Record<string, unknown>>,
  closedPositions: [] as Array<Record<string, unknown>>,
};

const resolveMidPrice = (symbol: string, providedMid?: number) => {
  if (typeof providedMid === "number" && Number.isFinite(providedMid) && providedMid > 0) {
    return providedMid;
  }

  const symbolBias = 95 + symbol.length * 3 + symbol.charCodeAt(0) % 17;
  return Number(symbolBias.toFixed(4));
};

const getSpreadPct = (symbol: string) => {
  const base = symbol.endsWith("USD") ? 0.018 : symbol.length % 2 === 0 ? 0.028 : 0.034;
  const connectionPenalty = state.connected ? 1 : 1.35;
  return Number((base * connectionPenalty).toFixed(4));
};

app.get("/health", async (_request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/health");
    // Always return 200 from the adapter itself — bridge connectivity is a warning, not a fatal
    const bridgeOk = result.status === 200 && !result.bridgeError;
    return reply.status(200).send({
      ok: true,
      bridgeConnected: bridgeOk,
      bridgeUrl: mt5BridgeUrl,
      bridgeError: result.bridgeError ?? null,
      mode: config.trading.mode,
    });
  }

  return {
    ok: true,
    bridgeConnected: false,
    bridgeUrl: null,
    bridgeError: "MT5_BRIDGE_URL not set — running in paper mock mode",
    mode: state.mode,
    lastSyncAt: state.lastSyncAt,
  };
});

app.get("/health/deep", async (_request, reply) => {
  const startedAt = Date.now();

  if (useLiveBridge) {
    let result = await proxyToBridge("/health/deep");
    if (result.status === 404) {
      result = await proxyToBridge("/health");
    }
    const latencyMs = Date.now() - startedAt;
    const payload = result.data as {
      reachable?: boolean;
      bridgeConnected?: boolean;
      terminalConnected?: boolean;
      brokerConnected?: boolean;
      loginMatches?: boolean;
      latencyMs?: number;
      lastError?: string | null;
    };
    const bridgeOk = result.status === 200 && !result.bridgeError && (payload.bridgeConnected ?? true);
    return reply.status(200).send({
      ok: true,
      reachable: payload.reachable ?? bridgeOk,
      bridgeConnected: payload.bridgeConnected ?? bridgeOk,
      terminalConnected: payload.terminalConnected ?? bridgeOk,
      brokerConnected: payload.brokerConnected ?? bridgeOk,
      loginMatches: payload.loginMatches ?? true,
      latencyMs: payload.latencyMs ?? latencyMs,
      bridgeUrl: mt5BridgeUrl,
      bridgeError: result.bridgeError ?? payload.lastError ?? null,
      mode: config.trading.mode,
      timestamp: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    reachable: state.connected,
    bridgeConnected: state.connected,
    terminalConnected: state.connected,
    brokerConnected: state.connected,
    loginMatches: true,
    latencyMs: Date.now() - startedAt,
    bridgeUrl: null,
    bridgeError: state.connected ? null : "MT5_BRIDGE_URL not set — running in paper mock mode",
    mode: state.mode,
    timestamp: new Date().toISOString(),
  };
});

app.get<{ Params: { accountId: string } }>("/accounts/:accountId/health/deep", async (request, reply) => {
  const startedAt = Date.now();

  if (useLiveBridge) {
    let result = await proxyToBridge("/health/deep");
    if (result.status === 404) {
      result = await proxyToBridge("/health");
    }
    const latencyMs = Date.now() - startedAt;
    const payload = result.data as {
      reachable?: boolean;
      bridgeConnected?: boolean;
      terminalConnected?: boolean;
      brokerConnected?: boolean;
      loginMatches?: boolean;
      latencyMs?: number;
      lastError?: string | null;
    };
    const bridgeOk = result.status === 200 && !result.bridgeError && (payload.bridgeConnected ?? true);
    return reply.status(200).send({
      ok: true,
      accountId: request.params.accountId,
      reachable: payload.reachable ?? bridgeOk,
      bridgeConnected: payload.bridgeConnected ?? bridgeOk,
      terminalConnected: payload.terminalConnected ?? bridgeOk,
      brokerConnected: payload.brokerConnected ?? bridgeOk,
      loginMatches: payload.loginMatches ?? true,
      latencyMs: payload.latencyMs ?? latencyMs,
      bridgeUrl: mt5BridgeUrl,
      bridgeError: result.bridgeError ?? payload.lastError ?? null,
      mode: config.trading.mode,
      timestamp: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    accountId: request.params.accountId,
    reachable: state.connected,
    bridgeConnected: state.connected,
    terminalConnected: state.connected,
    brokerConnected: state.connected,
    loginMatches: true,
    latencyMs: Date.now() - startedAt,
    bridgeUrl: null,
    bridgeError: state.connected ? null : "MT5_BRIDGE_URL not set — running in paper mock mode",
    mode: state.mode,
    timestamp: new Date().toISOString(),
  };
});

app.post("/connect", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/connect", "POST", request.body);
    return reply.status(result.status).send(result.data);
  }
  const payload = mt5ConnectRequestSchema.parse(request.body);
  state.connected = true;
  state.mode = payload.mode;
  state.account.mode = payload.mode;
  state.lastSyncAt = new Date().toISOString();
  logger.info("MT5 adapter connected", { mode: payload.mode, server: payload.server, login: payload.login });
  return { connected: true, mode: payload.mode, lastSyncAt: state.lastSyncAt };
});

app.post("/disconnect", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/disconnect", "POST", request.body);
    return reply.status(result.status).send(result.data);
  }

  state.connected = false;
  state.lastSyncAt = new Date().toISOString();
  logger.info("MT5 adapter disconnected");
  return { connected: false, lastSyncAt: state.lastSyncAt };
});

app.get("/account", async (_request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/account");
    if (result.status !== 200 || result.bridgeError) {
      // Bridge is down — return 503 so the dashboard shows disconnected
      return reply.status(503).send({ error: result.data });
    }
    // Python bridge AccountResponse schema fields: balance, equity, margin, margin_free, profit, currency, leverage
    const d = result.data as {
      balance: number;
      equity: number;
      margin_free?: number;
      margin?: number;
      profit: number;
    };
    const balance = d.balance ?? 0;
    const equity = d.equity ?? balance;
    const openPnl = d.profit ?? (equity - balance);
    const usedMargin = d.margin ?? 0;
    const freeMargin = d.margin_free ?? (equity - usedMargin);
    const drawdownPct = balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0;
    // Compute risk state based on daily loss and drawdown
    const dailyLossLimit = config.risk.maxDailyLossPct;
    const riskState =
      config.trading.killSwitch ? "KILL_SWITCH"
      : drawdownPct >= dailyLossLimit * 0.9 ? "BLOCKED"
      : drawdownPct >= dailyLossLimit * 0.6 ? "CAUTION"
      : "NORMAL";

    return {
      balance,
      equity,
      freeMargin,
      usedMargin,
      openPnl,
      realizedPnlDaily: 0, // MT5 bridge doesn't expose this directly; supervisor tracks it
      drawdownPct: Number(drawdownPct.toFixed(3)),
      maxDrawdownPct: dailyLossLimit,
      riskState,
      killSwitchActive: config.trading.killSwitch,
      mode: config.trading.mode,
    };
  }
  return state.account;
});

app.get("/positions", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/positions");
    return reply.status(result.status).send(result.data);
  }
  return state.positions;
});

app.get("/orders", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/orders");
    return reply.status(result.status).send(result.data);
  }
  return state.orders;
});

app.get("/history", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/history");
    return reply.status(result.status).send(result.data);
  }
  return state.closedPositions;
});
app.get<{ Params: { symbol: string } }>("/quote/:symbol", async (request, reply) => {
  if (useLiveBridge) {
    const { symbol } = request.params;
    const query = request.query as { mid?: string };
    const requestedMid = query.mid ? Number(query.mid) : undefined;
    const path = `/quote/${encodeURIComponent(symbol)}${requestedMid ? `?mid=${requestedMid}` : ""}`;
    const result = await proxyToBridge(path);
    return reply.status(result.status).send(result.data);
  }

  const { symbol } = request.params;
  const query = request.query as { mid?: string };
  const requestedMid = query.mid ? Number(query.mid) : undefined;
  const mid = resolveMidPrice(symbol, requestedMid);
  const spreadPct = getSpreadPct(symbol);
  const halfSpread = (mid * spreadPct) / 200;

  return {
    symbol,
    bid: Number((mid - halfSpread).toFixed(5)),
    ask: Number((mid + halfSpread).toFixed(5)),
    mid: Number(mid.toFixed(5)),
    spreadPct,
    connected: state.connected,
  };
});

app.post("/orders", async (request, reply) => {
  if (useLiveBridge) {
    // Translate from internal schema → Python bridge MarketOrderRequest schema
    // Internal: { symbol, direction: "LONG"|"SHORT", quantity, entry, stopLoss, takeProfit, decisionId }
    // Bridge:   { symbol, side: "buy"|"sell", volume, sl, tp, comment }
    const payload = mt5OrderRequestSchema.parse(request.body);
    const bridgeBody = {
      symbol: payload.symbol,
      side: payload.direction === "LONG" ? "buy" : "sell",
      volume: payload.quantity,
      sl: payload.stopLoss,
      tp: payload.takeProfit,
      comment: `scalper-${payload.decisionId.slice(0, 8)}`,
    };
    const commandId = stableHash({
      action: "place",
      decisionId: payload.decisionId,
      symbol: payload.symbol,
      direction: payload.direction,
      quantity: payload.quantity,
      entry: payload.entry,
      minute: new Date().toISOString().slice(0, 16),
    });
    const result = await proxyToBridge("/orders", "POST", bridgeBody, {
      "x-command-id": commandId,
    });
    if (result.status === 200 || result.status === 201) {
      // Normalise bridge response to our order shape
      const r = result.data as { ticket?: number; price?: number; volume?: number; retcode?: number; comment?: string };
      return reply.status(200).send({
        orderId: `mt5-${r.ticket ?? Date.now()}`,
        brokerOrderId: String(r.ticket ?? ""),
        status: "FILLED",
        symbol: payload.symbol,
        direction: payload.direction,
        quantity: r.volume ?? payload.quantity,
        entry: r.price ?? payload.entry,
        decisionId: payload.decisionId,
        createdAt: new Date().toISOString(),
      });
    }
    return reply.status(result.status).send(result.data);
  }
  if (!state.connected) {
    reply.code(409);
    return { error: "MT5 adapter is not connected." };
  }

  const payload = mt5OrderRequestSchema.parse(request.body);
  const brokerOrderId = `mt5-${stableHash(payload).slice(0, 12)}`;
  const order = {
    orderId: `order-${state.orders.length + 1}`,
    brokerOrderId,
    status: "FILLED",
    symbol: payload.symbol,
    quantity: payload.quantity,
    direction: payload.direction,
    entry: payload.entry,
    createdAt: new Date().toISOString(),
    decisionId: payload.decisionId,
  };
  state.orders.unshift(order);
  state.positions.unshift({
    positionId: `position-${state.positions.length + 1}`,
    brokerPositionId: brokerOrderId,
    symbol: payload.symbol,
    direction: payload.direction,
    quantity: payload.quantity,
    averageEntryPrice: payload.entry,
    stopLoss: payload.stopLoss,
    takeProfit: payload.takeProfit,
    unrealizedPnl: 0,
    exposurePct: 0.75,
    status: "OPEN",
    openedAt: new Date().toISOString(),
  });
  state.account.usedMargin += payload.quantity * payload.entry * 0.1;
  state.account.freeMargin = Math.max(0, state.account.equity - state.account.usedMargin);
  state.lastSyncAt = new Date().toISOString();

  return order;
});

app.post<{ Params: { positionId: string } }>("/positions/:positionId/close", async (request, reply) => {
  if (useLiveBridge) {
    // Bridge route: POST /positions/{ticket}/close (ticket is the MT5 position ticket integer)
    const { positionId } = request.params;
    const ticket = Number(positionId);
    if (isNaN(ticket)) {
      return reply.status(400).send({ error: `Invalid positionId (expected numeric MT5 ticket): ${positionId}` });
    }
    const commandId = stableHash({
      action: "close",
      ticket,
      minute: new Date().toISOString().slice(0, 16),
    });
    const result = await proxyToBridge(`/positions/${ticket}/close`, "POST", undefined, {
      "x-command-id": commandId,
    });
    return reply.status(result.status).send(result.data);
  }

  const { positionId } = request.params;
  const index = state.positions.findIndex((position) => position.positionId === positionId);
  if (index === -1) {
    reply.code(404);
    return { error: "Position not found." };
  }

  const [position] = state.positions.splice(index, 1);
  const closed = {
    ...position,
    status: "CLOSED",
    closedAt: new Date().toISOString(),
  };
  state.closedPositions.unshift(closed);
  state.account.realizedPnlDaily += 125;
  state.account.equity += 125;
  state.account.balance += 125;
  state.lastSyncAt = new Date().toISOString();
  return { closed: true, position: closed };
});

app.get<{ Params: { accountId: string } }>("/accounts/:accountId/account", async (_request, reply) => {
  const delegated = await (app.inject as any)({ method: "GET", url: "/account" });
  return reply.status(delegated.statusCode).send(delegated.json());
});

app.get<{ Params: { accountId: string } }>("/accounts/:accountId/positions", async (_request, reply) => {
  const delegated = await (app.inject as any)({ method: "GET", url: "/positions" });
  return reply.status(delegated.statusCode).send(delegated.json());
});

app.post<{ Params: { accountId: string } }>("/accounts/:accountId/orders", async (request, reply) => {
  const { accountId } = request.params;
  const accountBridgeUrl = resolveBridgeUrlForAccount(accountId);
  const bridgeAvailable = accountBridgeUrl.length > 0;

  if (bridgeAvailable) {
    const payload = mt5OrderRequestSchema.parse(request.body);
    const commandId = (request.headers["x-command-id"] as string) || stableHash({
      action: "place",
      decisionId: payload.decisionId,
      accountId,
      symbol: payload.symbol,
      direction: payload.direction,
      quantity: payload.quantity,
      minute: new Date().toISOString().slice(0, 16),
    });
    const bridgeBody = {
      symbol: payload.symbol,
      side: payload.direction === "LONG" ? "buy" : "sell",
      volume: payload.quantity,
      sl: payload.stopLoss,
      tp: payload.takeProfit,
      comment: `scalper-${payload.decisionId.slice(0, 8)}`,
    };
    const result = await proxyToBridge("/orders", "POST", bridgeBody, {
      "x-command-id": commandId,
      "x-account-id": accountId,
    });
    if (result.status === 200 || result.status === 201) {
      const r = result.data as { ticket?: number; price?: number; volume?: number };
      return reply.status(200).send({
        orderId: `mt5-${r.ticket ?? Date.now()}`,
        brokerOrderId: String(r.ticket ?? ""),
        status: "FILLED",
        symbol: payload.symbol,
        direction: payload.direction,
        quantity: r.volume ?? payload.quantity,
        entry: r.price ?? payload.entry,
        decisionId: payload.decisionId,
        createdAt: new Date().toISOString(),
      });
    }
    return reply.status(result.status).send(result.data);
  }

  // No bridge URL — check if mock fallback is permitted for this account
  if (!isMockFallbackAllowed()) {
    logger.error("Placement blocked — bridge unavailable and mock fallback is disabled for this account", { accountId });
    return reply.status(503).send({
      error: "MT5 bridge unavailable and mock fallback is not permitted for funded/live accounts.",
      accountId,
    });
  }

  // Paper mock fallback
  const delegated = await (app.inject as any)({
    method: "POST",
    url: "/orders",
    payload: request.body as any,
  });
  return reply.status(delegated.statusCode).send(delegated.json());
});

app.post<{ Params: { accountId: string; positionId: string } }>(
  "/accounts/:accountId/positions/:positionId/close",
  async (request, reply) => {
    const { accountId, positionId } = request.params;
    const accountBridgeUrl = resolveBridgeUrlForAccount(accountId);
    const bridgeAvailable = accountBridgeUrl.length > 0;

    if (bridgeAvailable) {
      const ticket = Number(positionId);
      if (isNaN(ticket)) {
        return reply.status(400).send({ error: `Invalid positionId (expected numeric MT5 ticket): ${positionId}` });
      }
      const commandId = (request.headers["x-command-id"] as string) || stableHash({
        action: "close",
        ticket,
        accountId,
        minute: new Date().toISOString().slice(0, 16),
      });
      const result = await proxyToBridge(`/positions/${ticket}/close`, "POST", undefined, {
        "x-command-id": commandId,
        "x-account-id": accountId,
      });
      return reply.status(result.status).send(result.data);
    }

    if (!isMockFallbackAllowed()) {
      return reply.status(503).send({
        error: "MT5 bridge unavailable and mock fallback is not permitted for funded/live accounts.",
        accountId,
      });
    }

    const delegated = await (app.inject as any)({
      method: "POST",
      url: `/positions/${positionId}/close`,
    });
    return reply.status(delegated.statusCode).send(delegated.json());
  },
);

const adapterPort = Number(process.env.MT5_ADAPTER_PORT ?? "4310");
app.listen({ port: adapterPort, host: "0.0.0.0" }).then(() => {
  logger.info("MT5 adapter listening", { port: adapterPort });
});
