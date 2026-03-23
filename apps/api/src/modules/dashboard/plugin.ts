import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { getDashboardSummary } from "./service";

export const dashboardPlugin = async (app: FastifyInstance) => {
  app.get("/api/dashboard/summary", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async () =>
    getDashboardSummary(),
  );
};
