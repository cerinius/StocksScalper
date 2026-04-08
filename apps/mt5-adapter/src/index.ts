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

console.log('MT5_BRIDGE_URL:', process.env.MT5_BRIDGE_URL, 'mt5BridgeUrl:', mt5BridgeUrl, 'useLiveBridge:', useLiveBridge);

const proxyToBridge = async (path: string, method: string = "GET", body?: unknown) => {
  if (!useLiveBridge) {
    throw new Error("MT5_BRIDGE_URL is not configured");
  }

  const url = `${mt5BridgeUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { status: response.status, data };
};

const state = {
  connected: false,
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

app.get("/health", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/health");
    return reply.status(result.status).send(result.data);
  }

  return {
    ok: true,
    connected: state.connected,
    mode: state.mode,
    lastSyncAt: state.lastSyncAt,
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

app.get("/account", async (request, reply) => {
  if (useLiveBridge) {
    const result = await proxyToBridge("/account");
    if (result.status !== 200) {
      return reply.status(result.status).send(result.data);
    }
    const data = result.data;
    return {
      balance: data.balance,
      equity: data.equity,
      freeMargin: data.equity, // approximate
      usedMargin: 0,
      lastSyncAt: new Date().toISOString()
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
    const result = await proxyToBridge("/orders/market", "POST", request.body);
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
    const { positionId } = request.params;
    const body = { position_ticket: Number(positionId) };
    const result = await proxyToBridge("/orders/close", "POST", body);
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

const adapterPort = Number(process.env.MT5_ADAPTER_PORT ?? "4310");
app.listen({ port: adapterPort, host: "0.0.0.0" }).then(() => {
  logger.info("MT5 adapter listening", { port: adapterPort });
});
