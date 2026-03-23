import { tradingViewWebhookSchema } from "@stock-radar/types";
import { createPlatformQueues } from "@stock-radar/queues";
import { prisma } from "@stock-radar/db";
import { buildReasoningLog, stableHash } from "@stock-radar/shared";
import { Prisma } from "@prisma/client";
import { writeAuditLog } from "../../lib/audit";

const queues = createPlatformQueues();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

export const ingestTradingViewWebhook = async (payload: unknown, sourceIp?: string) => {
  const parsed = tradingViewWebhookSchema.parse(payload);
  const dedupeHash = stableHash(parsed);

  const existing = await prisma.incomingWebhook.findUnique({ where: { dedupeHash } });
  if (existing) {
    return { duplicate: true, webhookId: existing.id };
  }

  const symbol = await prisma.symbol.upsert({
    where: { ticker: parsed.symbol },
    update: { isActive: true },
    create: {
      ticker: parsed.symbol,
      name: parsed.symbol,
      assetClass: "EQUITY",
      exchange: "TRADINGVIEW",
      sector: "Signal",
    },
  });

  const candidate = await prisma.tradeCandidate.create({
    data: {
      symbolId: symbol.id,
      sourceWorkerType: "MARKET",
      timeframe: parsed.timeframe,
      direction: parsed.direction,
      strategyType: parsed.strategy,
      detectedAt: new Date(),
      currentPrice: parsed.price ?? 100,
      proposedEntry: parsed.price ?? 100,
      stopLoss: parsed.price ? parsed.price * 0.99 : 99,
      takeProfit: parsed.price ? parsed.price * 1.02 : 102,
      riskReward: 2,
      confidenceScore: 62,
      setupScore: 61,
      featureValues: asJson({ tradingView: 1 }),
      indicatorSnapshot: asJson({}),
      reasoningLog: asJson(buildReasoningLog([
        {
          title: "TradingView alert received",
          detail: parsed.message || "Webhook was mapped into an internal trade idea.",
          weight: 0.6,
          tags: ["tradingview"],
        },
      ])),
      status: "NEW",
      correlationTags: asJson(["tradingview", parsed.direction.toLowerCase()]),
      volatilityClassification: "unknown",
      newsContext: asJson([]),
      dedupeHash,
    },
  });

  const webhook = await prisma.incomingWebhook.create({
    data: {
      kind: "TRADINGVIEW",
      sourceIp,
      headers: {},
      payload: asJson(parsed),
      signatureValid: true,
      dedupeHash,
      processingStatus: "PROCESSED",
      processedAt: new Date(),
      createdCandidateId: candidate.id,
    },
  });

  await queues.validation.add("candidateFromWebhook", { candidateId: candidate.id, trigger: "candidate_created" });

  await writeAuditLog({
    actorType: "WEBHOOK",
    actorId: webhook.id,
    category: "webhook.tradingview",
    message: `TradingView alert ingested for ${parsed.symbol}.`,
    entityType: "incoming_webhook",
    entityId: webhook.id,
    symbolId: symbol.id,
    data: parsed.metadata,
  });

  return { duplicate: false, webhookId: webhook.id, candidateId: candidate.id };
};
