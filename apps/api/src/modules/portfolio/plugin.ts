import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { getPortfolioOverview } from "./service";

export const portfolioPlugin = async (app: FastifyInstance) => {
  app.get("/api/portfolio", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async () =>
    getPortfolioOverview(),
  );
};
