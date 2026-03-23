import type { FastifyInstance } from "fastify";
import { getPlatformConfig } from "@stock-radar/config";
import { ingestTradingViewWebhook } from "./service";

const config = getPlatformConfig();

export const webhooksPlugin = async (app: FastifyInstance) => {
  app.post("/api/webhooks/tradingview", async (request, reply) => {
    const secretHeader = request.headers["x-tradingview-secret"];
    const secret = typeof secretHeader === "string" ? secretHeader : "";
    if (secret !== config.tradingViewWebhookSecret) {
      reply.code(401);
      return { error: "Invalid webhook secret" };
    }

    return ingestTradingViewWebhook(request.body, request.ip);
  });
};
