import Fastify from "fastify";
import { getPlatformConfig } from "@stock-radar/config";
import { createLogger } from "@stock-radar/logging";
import { mt5ConnectRequestSchema, mt5OrderRequestSchema } from "@stock-radar/types";
import { stableHash } from "@stock-radar/shared";

const config = getPlatformConfig();
const logger = createLogger("mt5-adapter");
const app = Fastify({ logger: false });

const state = {
  connected: false,
  mode: config.trading.mode,
  lastSyncAt: new Date().toISOString(),
  account: {
    balance: 125_000,
    equity: 125_000,
    freeMargin: 110_000,
    usedMargin: 15_000,
    openPnl: 0,
    realizedPnlDaily: 0,
    drawdownPct: 0,
    maxDrawdownPct: 2.8,
    riskState: "NORMAL" as const,
    killSwitchActive: false,
    mode: config.trading.mode,
  },
  orders: [] as Array<Record<string, unknown>>,
  positions: [] as Array<Record<string, unknown>>,
  closedPositions: [] as Array<Record<string, unknown>>,
};

app.get("/health", async () => ({
  ok: true,
  connected: state.connected,
  mode: state.mode,
  lastSyncAt: state.lastSyncAt,
}));

app.post("/connect", async (request) => {
  const payload = mt5ConnectRequestSchema.parse(request.body);
  state.connected = true;
  state.mode = payload.mode;
  state.account.mode = payload.mode;
  state.lastSyncAt = new Date().toISOString();
  logger.info("MT5 adapter connected", { mode: payload.mode, server: payload.server, login: payload.login });
  return { connected: true, mode: payload.mode, lastSyncAt: state.lastSyncAt };
});

app.post("/disconnect", async () => {
  state.connected = false;
  state.lastSyncAt = new Date().toISOString();
  logger.info("MT5 adapter disconnected");
  return { connected: false, lastSyncAt: state.lastSyncAt };
});

app.get("/account", async () => state.account);
app.get("/positions", async () => state.positions);
app.get("/orders", async () => state.orders);
app.get("/history", async () => state.closedPositions);

app.post("/orders", async (request, reply) => {
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

app.post("/positions/:positionId/close", async (request, reply) => {
  const { positionId } = request.params as { positionId: string };
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

app.listen({ port: config.ports.mt5Adapter, host: "0.0.0.0" }).then(() => {
  logger.info("MT5 adapter listening", { port: config.ports.mt5Adapter });
});
