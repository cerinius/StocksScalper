import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBacktestReport } from "../services/analytics";

export const backtestRoutes = async (app: FastifyInstance) => {
  app.get("/api/backtests", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .parse(request.query);

    return getBacktestReport(query.limit);
  });
};
