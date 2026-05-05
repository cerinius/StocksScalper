import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { listAccountsOverview, getAccountDetail } from "./service";

export const accountsPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/accounts",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async () => listAccountsOverview(),
  );

  app.get(
    "/api/accounts/:id",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const detail = await getAccountDetail(params.id);
      if (!detail) {
        reply.code(404);
        return { error: "Account not found" };
      }
      return detail;
    },
  );
};
