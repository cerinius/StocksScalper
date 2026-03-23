import { getPlatformConfig } from "@stock-radar/config";
import { prisma } from "@stock-radar/db";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    platformUser?: {
      id: string;
      email: string;
      name: string;
      roles: string[];
    };
  }
}

const config = getPlatformConfig();

export const resolvePlatformUser = async (request: FastifyRequest) => {
  const emailHeader = request.headers["x-user-email"];
  const email = typeof emailHeader === "string" ? emailHeader : config.localAdmin.email;

  const user = await prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: true } } },
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles.map((entry) => entry.role.key),
  };
};

export const authPreHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const user = await resolvePlatformUser(request);
  if (!user) {
    reply.code(401);
    return { error: "Unauthorized" };
  }

  request.platformUser = user;
  return undefined;
};

export const requireRole =
  (...roles: string[]) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.platformUser ?? (await resolvePlatformUser(request));
    if (!user) {
      reply.code(401);
      return { error: "Unauthorized" };
    }

    if (!user.roles.some((role) => roles.includes(role))) {
      reply.code(403);
      return { error: "Forbidden" };
    }

    request.platformUser = user;
    return undefined;
  };
