import Fastify from "fastify";
import { getPlatformConfig } from "@stock-radar/config";
import { prisma } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";

const config = getPlatformConfig();
const logger = createLogger("gateway");
const app = Fastify({ logger: false });

app.get("/health", async () => ({
  ok: true,
  service: "gateway",
  timestamp: new Date().toISOString(),
}));

app.get("/events", async (_request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
  });

  const timer = setInterval(async () => {
    const [account, workers, alerts] = await Promise.all([
      prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
      prisma.workerHeartbeat.findMany({ orderBy: { workerType: "asc" } }),
      prisma.riskEvent.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    ]);

    reply.raw.write(`data: ${JSON.stringify({ account, workers, alerts, timestamp: new Date().toISOString() })}\n\n`);
  }, 5_000);

  reply.raw.on("close", () => {
    clearInterval(timer);
  });

  return reply;
});

app.listen({ port: config.ports.gateway, host: "0.0.0.0" }).then(() => {
  logger.info("Gateway listening", { port: config.ports.gateway });
});
