import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { connectMt5, disconnectMt5, getIntegrationsOverview, syncMt5 } from "./service";

export const integrationsPlugin = async (app: FastifyInstance) => {
  app.get("/api/integrations", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async () =>
    getIntegrationsOverview(),
  );

  app.post("/api/integrations/mt5/connect", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR")] }, async (request) =>
    connectMt5((request.body as Record<string, unknown>) ?? {}, request.platformUser?.id),
  );

  app.post("/api/integrations/mt5/disconnect", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR")] }, async (request) =>
    disconnectMt5(request.platformUser?.id),
  );

  app.post("/api/integrations/mt5/sync", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async () =>
    syncMt5(),
  );
};
