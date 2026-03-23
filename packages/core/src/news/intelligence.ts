import type {
  DirectionalBias,
  NewsIntelligenceRecord,
  NewsUrgency,
  ReasoningEntry,
  VolatilityImpact,
} from "@stock-radar/types";
import { buildReasoningLog, clamp, stableHash } from "@stock-radar/shared";

const bullishKeywords = ["beat", "raised", "upgrade", "approval", "expansion", "rebound"];
const bearishKeywords = ["miss", "downgrade", "probe", "cuts", "war", "recession", "inflation"];
const highUrgencyKeywords = ["breaking", "cpi", "ppi", "nfp", "fed", "ecb", "boj", "gdp", "emergency"];
const highVolatilityKeywords = ["rates", "inflation", "jobs", "war", "oil", "sanction", "earnings"];

const scoreKeywordHits = (text: string, keywords: string[]) =>
  keywords.reduce((count, keyword) => (text.includes(keyword) ? count + 1 : count), 0);

const inferBias = (text: string): DirectionalBias => {
  const bullish = scoreKeywordHits(text, bullishKeywords);
  const bearish = scoreKeywordHits(text, bearishKeywords);
  if (bullish === bearish) return "NEUTRAL";
  return bullish > bearish ? "BULLISH" : "BEARISH";
};

const inferUrgency = (text: string): NewsUrgency => {
  const hits = scoreKeywordHits(text, highUrgencyKeywords);
  if (hits >= 2) return "CRITICAL";
  if (hits === 1) return "HIGH";
  return text.includes("developing") ? "MEDIUM" : "LOW";
};

const inferVolatility = (text: string): VolatilityImpact => {
  const hits = scoreKeywordHits(text, highVolatilityKeywords);
  if (hits >= 2) return "HIGH";
  if (hits === 1) return "MEDIUM";
  return "LOW";
};

const inferRelevance = (symbols: string[], text: string) => clamp(symbols.length * 15 + text.length / 12, 10, 100);

export interface ScoreNewsInput {
  source: string;
  headline: string;
  summary: string;
  originalTimestamp: string;
  affectedSymbols: string[];
  affectedAssetClasses: string[];
  tags: string[];
  category: string;
  rawPayloadRef?: string;
}

export const scoreNewsIntelligence = (input: ScoreNewsInput): NewsIntelligenceRecord => {
  const text = `${input.headline} ${input.summary}`.toLowerCase();
  const directionalBias = inferBias(text);
  const urgency = inferUrgency(text);
  const volatilityImpact = inferVolatility(text);
  const relevanceScore = inferRelevance(input.affectedSymbols, text);
  const confidence = clamp(45 + relevanceScore * 0.4 + (urgency === "CRITICAL" ? 20 : urgency === "HIGH" ? 10 : 0), 0, 100);

  const reasoningLog: ReasoningEntry[] = buildReasoningLog([
    {
      title: "Urgency classification",
      detail: `Headline was scored as ${urgency.toLowerCase()} urgency based on macro and event-driven keywords.`,
      weight: urgency === "CRITICAL" ? 0.95 : urgency === "HIGH" ? 0.8 : 0.45,
      tags: ["urgency", input.category],
    },
    {
      title: "Directional inference",
      detail: `The tone leaned ${directionalBias.toLowerCase()} after weighing positive and negative catalysts in the text.`,
      weight: 0.6,
      tags: ["bias", directionalBias.toLowerCase()],
    },
    {
      title: "Volatility expectation",
      detail: `Expected volatility impact was classified as ${volatilityImpact.toLowerCase()} based on macro and risk keywords.`,
      weight: volatilityImpact === "HIGH" ? 0.85 : 0.55,
      tags: ["volatility"],
    },
  ]);

  return {
    source: input.source,
    headline: input.headline,
    summary: input.summary,
    originalTimestamp: input.originalTimestamp,
    ingestionTimestamp: new Date().toISOString(),
    affectedSymbols: input.affectedSymbols,
    affectedAssetClasses: input.affectedAssetClasses,
    directionalBias,
    urgency,
    relevanceScore,
    volatilityImpact,
    confidence,
    tags: input.tags,
    category: input.category,
    rawPayloadRef: input.rawPayloadRef ?? `${input.source}:${input.originalTimestamp}`,
    reasoningLog,
    dedupeHash: stableHash({
      source: input.source,
      headline: input.headline.toLowerCase(),
      summary: input.summary.toLowerCase(),
      symbols: [...input.affectedSymbols].sort(),
    }),
    status: "new",
  };
};
