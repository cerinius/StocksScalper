import { AllocationPolicy, AllocationStatus, Prisma } from "@prisma/client";
import { prisma } from "@stock-radar/db";

export interface AllocationListQuery {
  limit: number;
  status?: string;
  policy?: string;
  setupKey?: string;
  accountId?: string;
  selectedOnly?: boolean;
  search?: string;
}

const POLICY_VALUES = new Set<AllocationPolicy>([
  "ONE_ACCOUNT_ONLY",
  "MAX_N_ACCOUNTS",
  "ALL_ELIGIBLE",
  "CHALLENGE_ONLY",
  "FUNDED_ONLY",
  "STRATEGY_TAGGED",
]);

const STATUS_VALUES = new Set<AllocationStatus>([
  "PENDING",
  "ALLOCATED",
  "SKIPPED",
  "PARTIAL",
  "FAILED",
]);

const parseEnumList = <T extends string>(value: string | undefined, allowed: Set<T>): T[] | undefined => {
  if (!value) return undefined;
  const result = value
    .split(",")
    .map((v) => v.trim().toUpperCase() as T)
    .filter((v) => allowed.has(v));
  return result.length > 0 ? result : undefined;
};

export const listAllocationDecisions = async (query: AllocationListQuery) => {
  const policies = parseEnumList<AllocationPolicy>(query.policy, POLICY_VALUES);
  const statuses = parseEnumList<AllocationStatus>(query.status, STATUS_VALUES);

  const where: Prisma.AllocationDecisionWhereInput = {
    policy: policies ? { in: policies } : undefined,
    status: statuses ? { in: statuses } : undefined,
    setupKey: query.setupKey
      ? { contains: query.setupKey, mode: "insensitive" }
      : undefined,
    candidates: query.accountId || query.selectedOnly
      ? {
          some: {
            accountId: query.accountId ?? undefined,
            selected: query.selectedOnly ? true : undefined,
          },
        }
      : undefined,
    OR: query.search
      ? [
          { setupKey: { contains: query.search, mode: "insensitive" } },
          { candidate: { strategyType: { contains: query.search, mode: "insensitive" } } },
          { candidate: { symbol: { ticker: { contains: query.search, mode: "insensitive" } } } },
        ]
      : undefined,
  };

  return prisma.allocationDecision.findMany({
    where,
    include: {
      candidate: { include: { symbol: true } },
      candidates: {
        include: { account: true },
        orderBy: [{ selected: "desc" }, { totalScore: "desc" }, { createdAt: "desc" }],
      },
      decisions: {
        include: {
          account: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
};
