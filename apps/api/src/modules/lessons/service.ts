import { prisma } from "@stock-radar/db";

export interface LessonsQuery {
  accountId?: string;
  active?: boolean;
  tags?: string[];
  scope?: string;
  limit: number;
  offset: number;
}

export const getLessons = async (query: LessonsQuery) => {
  const where: Record<string, unknown> = {};
  if (query.accountId) where.accountId = query.accountId;
  if (query.active !== undefined) where.active = query.active;

  const [rows, total] = await Promise.all([
    (prisma as any).aiLesson.findMany({
      where,
      orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
      skip: query.offset,
      take: query.limit,
      include: {
        account: { select: { id: true, label: true } },
      },
    }),
    (prisma as any).aiLesson.count({ where }),
  ]);

  return { rows, total, offset: query.offset, limit: query.limit };
};

export const getLessonById = async (id: string) => {
  return (prisma as any).aiLesson.findUnique({
    where: { id },
    include: { account: { select: { id: true, label: true } } },
  });
};

export const archiveLesson = async (id: string) => {
  return (prisma as any).aiLesson.update({
    where: { id },
    data: { active: false },
  });
};

export const createManualLesson = async (data: {
  accountId?: string;
  title: string;
  detail: string;
  tags: string[];
  weight?: number;
}) => {
  return (prisma as any).aiLesson.create({
    data: {
      sourceKind: "MANUAL",
      sourceId: null,
      accountId: data.accountId ?? null,
      title: data.title,
      detail: data.detail,
      tags: data.tags,
      weight: data.weight ?? 0.5,
      active: true,
    },
  });
};
