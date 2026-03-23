import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { getWorkersOverview } from "./service";

export const workersPlugin = async (app: FastifyInstance) => {
  app.get("/api/workers", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async () =>
    getWorkersOverview(),
  );
};
