import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getAiHealth, getRecentAiReviews, answerNaturalLanguageQuery } from "./service";

export const aiPlugin = async (app: FastifyInstance) => {
  // AI system health
  app.get(
    "/api/ai/health",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async () => {
      return getAiHealth();
    },
  );

  // Recent AI reviews
  app.get(
    "/api/ai/reviews",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const q = request.query as { limit?: string; kind?: string };
      return getRecentAiReviews(parseLimit(q.limit, 50, 200), q.kind);
    },
  );

  // Natural language query
  app.post(
    "/api/ai/ask",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const body = request.body as { question: string; accountId?: string };
      if (!body?.question || typeof body.question !== "string") {
        throw new Error("question is required");
      }
      return answerNaturalLanguageQuery(body.question.slice(0, 500), body.accountId);
    },
  );
};
