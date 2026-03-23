import { prisma } from "@stock-radar/db";

export const getNotificationOverview = async (limit: number) => {
  const [notifications, templates] = await Promise.all([
    prisma.notification.findMany({
      include: { template: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notificationTemplate.findMany({
      orderBy: { key: "asc" },
    }),
  ]);

  return { notifications, templates };
};
