import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getLessons, getLessonById, archiveLesson, createManualLesson } from "./service";

export const lessonsPlugin = async (app: FastifyInstance) => {
  // List lessons with filters
  app.get(
    "/api/lessons",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const q = request.query as {
        accountId?: string;
        active?: string;
        limit?: string;
        offset?: string;
      };
      return getLessons({
        accountId: q.accountId,
        active: q.active !== undefined ? q.active !== "false" : undefined,
        limit: parseLimit(q.limit, 25, 200),
        offset: q.offset ? parseInt(q.offset, 10) : 0,
      });
    },
  );

  // Get a single lesson
  app.get(
    "/api/lessons/:id",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const { id } = request.params as { id: string };
      const lesson = await getLessonById(id);
      if (!lesson) throw (request as any).server.httpErrors?.notFound("Lesson not found");
      return lesson;
    },
  );

  // Archive (soft-delete) a lesson
  app.patch(
    "/api/lessons/:id/archive",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR")] },
    async (request) => {
      const { id } = request.params as { id: string };
      return archiveLesson(id);
    },
  );

  // Create a manual lesson
  app.post(
    "/api/lessons",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR")] },
    async (request) => {
      const body = request.body as {
        accountId?: string;
        title: string;
        detail: string;
        tags?: string[];
        weight?: number;
      };
      return createManualLesson({
        accountId: body.accountId,
        title: body.title,
        detail: body.detail,
        tags: body.tags ?? [],
        weight: body.weight,
      });
    },
  );
};
