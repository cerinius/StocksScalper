import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getNotificationOverview } from "./service";

export const notificationsPlugin = async (app: FastifyInstance) => {
  app.get("/api/notifications", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return getNotificationOverview(parseLimit(query.limit, 30, 100));
  });
};
