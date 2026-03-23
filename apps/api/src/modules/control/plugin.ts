import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler, requireRole } from "../../lib/auth";
import { setKillSwitch, triggerWorkerJob } from "./service";

const killSwitchSchema = z.object({
  active: z.boolean(),
});

export const controlPlugin = async (app: FastifyInstance) => {
  app.post("/api/control/jobs/:worker", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR")] }, async (request) =>
    triggerWorkerJob((request.params as { worker: string }).worker, request.platformUser?.id),
  );

  app.post("/api/control/kill-switch", { preHandler: [authPreHandler, requireRole("ADMIN", "RISK_MANAGER")] }, async (request) => {
    const body = killSwitchSchema.parse(request.body);
    return setKillSwitch(body.active, request.platformUser?.id);
  });
};
