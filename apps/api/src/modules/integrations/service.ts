import { getPlatformConfig } from "@stock-radar/config";
import { prisma } from "@stock-radar/db";
import { Prisma } from "@prisma/client";
import { writeAuditLog } from "../../lib/audit";

const config = getPlatformConfig();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

export const getIntegrationsOverview = async () =>
  prisma.integration.findMany({
    include: {
      statuses: {
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      providerConfigs: true,
      accountSnapshots: {
        orderBy: { capturedAt: "desc" },
        take: 1,
      },
    },
    orderBy: { kind: "asc" },
  });

export const connectMt5 = async (payload: Record<string, unknown>, actorId?: string) => {
  const response = await fetch(`${config.services.mt5AdapterUrl}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as Record<string, unknown>;

  await prisma.integrationStatus.create({
    data: {
      integrationId: "seed-mt5",
      status: response.ok ? "CONNECTED" : "ERROR",
      summary: response.ok ? "MT5 adapter connected" : "MT5 adapter connection failed",
      details: asJson(data),
      lastHeartbeatAt: new Date(),
      lastSyncAt: new Date(),
    },
  });
  await writeAuditLog({
    actorType: "USER",
    actorId,
    category: "integration.mt5",
    message: response.ok ? "Connected MT5 adapter." : "Failed to connect MT5 adapter.",
    entityType: "integration",
    entityId: "seed-mt5",
    severity: response.ok ? "INFO" : "WARNING",
    data,
  });

  return data;
};

export const disconnectMt5 = async (actorId?: string) => {
  const response = await fetch(`${config.services.mt5AdapterUrl}/disconnect`, { method: "POST" });
  const data = (await response.json()) as Record<string, unknown>;

  await prisma.integrationStatus.create({
    data: {
      integrationId: "seed-mt5",
      status: "DISCONNECTED",
      summary: "MT5 adapter disconnected",
      details: asJson(data),
      lastHeartbeatAt: new Date(),
      lastSyncAt: new Date(),
    },
  });
  await writeAuditLog({
    actorType: "USER",
    actorId,
    category: "integration.mt5",
    message: "Disconnected MT5 adapter.",
    entityType: "integration",
    entityId: "seed-mt5",
    data,
  });

  return data;
};

export const syncMt5 = async () => {
  const [health, account, positions, orders] = await Promise.all([
    fetch(`${config.services.mt5AdapterUrl}/health`).then((response) => response.json()),
    fetch(`${config.services.mt5AdapterUrl}/account`).then((response) => response.json()),
    fetch(`${config.services.mt5AdapterUrl}/positions`).then((response) => response.json()),
    fetch(`${config.services.mt5AdapterUrl}/orders`).then((response) => response.json()),
  ]);

  return { health, account, positions, orders };
};
