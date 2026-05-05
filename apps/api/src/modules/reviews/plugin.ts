import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getReviews, getReviewById, getWeeklyReviews, getSupervisionTicks } from "./service";

export const reviewsPlugin = async (app: FastifyInstance) => {
  // List AI reviews with filters
  app.get(
    "/api/reviews",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const q = request.query as {
        accountId?: string;
        kind?: string;
        verdict?: string;
        positionId?: string;
        limit?: string;
        offset?: string;
      };
      return getReviews({
        accountId: q.accountId,
        kind: q.kind,
        verdict: q.verdict,
        positionId: q.positionId,
        limit: parseLimit(q.limit, 25, 200),
        offset: q.offset ? parseInt(q.offset, 10) : 0,
      });
    },
  );

  // Get a single review
  app.get(
    "/api/reviews/:id",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const { id } = request.params as { id: string };
      const review = await getReviewById(id);
      if (!review) return (request as any).server.httpErrors?.notFound("Review not found");
      return review;
    },
  );

  // Weekly review summaries
  app.get(
    "/api/reviews/weekly",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const q = request.query as { accountId?: string; limit?: string };
      return getWeeklyReviews(q.accountId, parseLimit(q.limit, 12, 52));
    },
  );

  // Supervision ticks for a position
  app.get(
    "/api/reviews/supervision/:positionId",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const { positionId } = request.params as { positionId: string };
      return getSupervisionTicks(positionId);
    },
  );
};
