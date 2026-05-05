import { prisma } from "@stock-radar/db";
import { OllamaClient } from "@stock-radar/ai";
import { naturalLanguageQueryOutputSchema } from "@stock-radar/types";

export const getAiHealth = async () => {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);

  const [recentReviews, failedRecent, latencyRows] = await Promise.all([
    (prisma as any).aiReview.count({
      where: { createdAt: { gte: fiveMinutesAgo } },
    }),
    (prisma as any).aiReview.count({
      where: {
        createdAt: { gte: fiveMinutesAgo },
        safetyFiltered: true,
      },
    }),
    (prisma as any).aiReview.findMany({
      where: { createdAt: { gte: oneHourAgo } },
      select: { latencyMs: true, kind: true, model: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  // Compute latency stats per kind
  const byKind = new Map<string, number[]>();
  for (const row of latencyRows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind)!.push(row.latencyMs);
  }

  const kindStats: Record<string, { count: number; p50: number; p95: number; avgMs: number }> = {};
  for (const [kind, latencies] of byKind) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;
    kindStats[kind] = {
      count: n,
      p50: sorted[Math.floor(n * 0.5)] ?? 0,
      p95: sorted[Math.floor(n * 0.95)] ?? 0,
      avgMs: n > 0 ? sorted.reduce((a, b) => a + b, 0) / n : 0,
    };
  }

  // Check if Ollama is reachable
  let ollamaReachable = false;
  let ollamaModel = process.env.OLLAMA_MODEL ?? "unknown";
  try {
    const resp = await fetch(`${process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    ollamaReachable = resp.ok;
  } catch {
    ollamaReachable = false;
  }

  const failureRate5m = recentReviews > 0 ? (failedRecent / recentReviews) * 100 : 0;

  return {
    enabled: process.env.OLLAMA_ENABLED !== "false",
    ollamaReachable,
    ollamaModel,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    failureRate5m,
    recentReviews,
    byKind: kindStats,
    circuitOpen: failureRate5m > 20,
  };
};

export const getRecentAiReviews = async (limit = 50, kind?: string) => {
  const where: Record<string, unknown> = {};
  if (kind) where.kind = kind;
  return (prisma as any).aiReview.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      model: true,
      promptVersion: true,
      verdict: true,
      confidence: true,
      summary: true,
      latencyMs: true,
      safetyFiltered: true,
      safetyFilterReasons: true,
      createdAt: true,
      accountId: true,
      positionId: true,
    },
  });
};

export const answerNaturalLanguageQuery = async (question: string, accountId?: string) => {
  const client = new OllamaClient();

  // Gather structured data based on the question keywords for grounding
  const recentPositions = await prisma.position.findMany({
    where: {
      ...(accountId ? { accountId } : {}),
      status: "CLOSED",
    },
    orderBy: { closedAt: "desc" },
    take: 20,
    include: { symbol: { select: { ticker: true } } },
  }) as any[];

  const recentLessons = await (prisma as any).aiLesson.findMany({
    where: { ...(accountId ? { accountId } : {}), active: true },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { title: true, detail: true, tags: true },
  });

  const prompt = JSON.stringify({
    question,
    instructions: "Answer the question using ONLY the data provided. If the answer is not in the data, say so explicitly. Cite specific records.",
    data: {
      recentClosedTrades: recentPositions.map((p: any) => ({
        symbol: p.symbol?.ticker,
        direction: p.direction,
        pnl: p.realizedPnl,
        closedAt: p.closedAt?.toISOString(),
      })),
      activeLessons: recentLessons,
    },
  });

  const result = await client.generateJson({
    schema: naturalLanguageQueryOutputSchema,
    system: [
      "You are a read-only analytics assistant for a funded trading system.",
      "Answer questions using ONLY the structured data provided. Never fabricate data.",
      "Always cite the specific records that support your answer.",
      "Return valid JSON matching the required schema.",
    ].join(" "),
    prompt,
    timeoutMs: 10_000,
    temperature: 0.1,
  });

  return {
    question,
    answer: result.output.answer,
    sources: result.output.sources,
    caveats: result.output.caveats,
    latencyMs: result.latencyMs,
    model: result.model,
  };
};
