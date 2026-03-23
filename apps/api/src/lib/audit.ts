import { Prisma } from "@prisma/client";
import { prisma } from "@stock-radar/db";
import type { WorkerType } from "@prisma/client";

const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

export const writeAuditLog = async (input: {
  actorType: "SYSTEM" | "USER" | "WORKER" | "WEBHOOK";
  actorId?: string;
  workerType?: WorkerType;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  category: string;
  message: string;
  entityType?: string;
  entityId?: string;
  symbolId?: string;
  correlationId?: string;
  data?: Record<string, unknown> | unknown[];
}) =>
  prisma.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      workerType: input.workerType,
      severity: input.severity ?? "INFO",
      category: input.category,
      message: input.message,
      entityType: input.entityType,
      entityId: input.entityId,
      symbolId: input.symbolId,
      correlationId: input.correlationId,
      data: input.data ? asJson(input.data) : undefined,
    },
  });
