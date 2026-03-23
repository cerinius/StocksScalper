import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { getPlatformConfig } from "@stock-radar/config";
import { createLogger } from "@stock-radar/logging";
import { authPreHandler } from "./lib/auth";
import { dashboardPlugin } from "./modules/dashboard/plugin";
import { workersPlugin } from "./modules/workers/plugin";
import { newsPlugin } from "./modules/news/plugin";
import { tradeIdeasPlugin } from "./modules/trade-ideas/plugin";
import { validationPlugin } from "./modules/validation/plugin";
import { executionPlugin } from "./modules/execution/plugin";
import { portfolioPlugin } from "./modules/portfolio/plugin";
import { integrationsPlugin } from "./modules/integrations/plugin";
import { auditPlugin } from "./modules/audit/plugin";
import { notificationsPlugin } from "./modules/notifications/plugin";
import { controlPlugin } from "./modules/control/plugin";
import { webhooksPlugin } from "./modules/webhooks/plugin";

const config = getPlatformConfig();
const logger = createLogger("api");
const app = Fastify({ logger: false });

const start = async () => {
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Stock Radar Platform API",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/session", { preHandler: authPreHandler }, async (request) => ({
    user: request.platformUser,
    tradingMode: config.trading.mode,
  }));

  await app.register(dashboardPlugin);
  await app.register(workersPlugin);
  await app.register(newsPlugin);
  await app.register(tradeIdeasPlugin);
  await app.register(validationPlugin);
  await app.register(executionPlugin);
  await app.register(portfolioPlugin);
  await app.register(integrationsPlugin);
  await app.register(auditPlugin);
  await app.register(notificationsPlugin);
  await app.register(controlPlugin);
  await app.register(webhooksPlugin);

  await app.listen({ port: config.ports.api, host: "0.0.0.0" });
  logger.info("API listening", { port: config.ports.api });
};

start().catch((error) => {
  logger.error("API failed to start", { error: error.message });
  process.exit(1);
});
