import { FastifyInstance } from "fastify";
import { getDashboardOverview } from "../services/analytics";

export const dashboardRoutes = async (app: FastifyInstance) => {
  app.get("/api/dashboard/overview", async () => {
    return getDashboardOverview();
  });
};
