"use client";

import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface AiReview {
  id: string;
  kind: string;
  model: string;
  promptVersion: string;
  verdict: string;
  confidence: number;
  summary: string;
  latencyMs: number;
  safetyFiltered: boolean;
  safetyFilterReasons: string[];
  createdAt: string;
  accountId: string | null;
  positionId: string | null;
  account: { id: string; label: string } | null;
  position: { symbol: { ticker: string } } | null;
}

interface ReviewsResponse {
  rows: AiReview[];
  total: number;
  limit: number;
  offset: number;
}

const VERDICT_TONE: Record<string, "good" | "warn" | "critical" | "default"> = {
  APPROVE: "good",
  APPROVE_WITH_CAUTION: "warn",
  NEUTRAL: "default",
  NO_ACTION: "default",
  CONCERNED: "warn",
  SUGGEST_REDUCE_SIZE: "warn",
  SUGGEST_TIGHTEN_STOP: "warn",
  SUGGEST_SCALE_OUT: "warn",
  SUGGEST_CLOSE: "critical",
  OBJECT: "critical",
};

const KIND_LABEL: Record<string, string> = {
  PRE_TRADE_CRITIC: "Pre-Trade",
  POSITION_SUPERVISOR: "Position",
  POST_TRADE_JOURNAL: "Post-Trade",
  WEEKLY_REVIEW: "Weekly",
  NATURAL_LANGUAGE_QUERY: "NLQ",
  NEWS_REVIEW: "News",
  RULE_DRIFT_REVIEW: "Rule Drift",
  SETUP_QUALITY_REVIEW: "Setup Quality",
};

export default function ReviewsPage() {
  const { data } = useSWR<ReviewsResponse>("/api/reviews?limit=50", fetcher, { refreshInterval: 15_000 });

  const reviews = data?.rows ?? [];
  const totalReviews = data?.total ?? 0;

  const byKind = reviews.reduce<Record<string, number>>((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {});

  const safetyFiltered = reviews.filter((r) => r.safetyFiltered).length;
  const avgLatency = reviews.length > 0
    ? Math.round(reviews.reduce((s, r) => s + r.latencyMs, 0) / reviews.length)
    : 0;

  return (
    <>
      <ScreenHeader
        eyebrow="AI Reviews"
        title="AI trade and position reviews"
        description="Advisory AI reviews for pre-trade critique, position supervision, and post-trade debriefs. AI is never the authority — it annotates the deterministic engine."
      />

      <div className="metrics-grid">
        <MetricCard label="Total reviews" value={totalReviews} />
        <MetricCard label="Pre-trade" value={byKind["PRE_TRADE_CRITIC"] ?? 0} />
        <MetricCard label="Position" value={byKind["POSITION_SUPERVISOR"] ?? 0} />
        <MetricCard label="Post-trade" value={byKind["POST_TRADE_JOURNAL"] ?? 0} />
        <MetricCard label="Safety filtered" value={safetyFiltered} tone={safetyFiltered > 0 ? "warn" : "default"} />
        <MetricCard label="Avg latency" value={`${avgLatency}ms`} />
      </div>

      <Panel title="Recent AI reviews" subtitle="Most recent 50 AI review calls across all kinds.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Account</th>
              <th>Symbol</th>
              <th>Verdict</th>
              <th>Confidence</th>
              <th>Latency</th>
              <th>Safety</th>
              <th>Summary</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id}>
                <td>
                  <span style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                </td>
                <td>{r.account?.label ?? "—"}</td>
                <td>{r.position?.symbol?.ticker ?? "—"}</td>
                <td>
                  <StatusPill tone={VERDICT_TONE[r.verdict] ?? "default"} label={r.verdict} />
                </td>
                <td>{r.confidence.toFixed(0)}%</td>
                <td>{r.latencyMs}ms</td>
                <td>
                  {r.safetyFiltered ? (
                    <StatusPill tone="warn" label="filtered" />
                  ) : (
                    <StatusPill tone="good" label="clean" />
                  )}
                </td>
                <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.summary}
                </td>
                <td>{formatDateTime(r.createdAt)}</td>
              </tr>
            ))}
            {reviews.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", opacity: 0.5 }}>
                  No AI reviews yet. Reviews appear as trades are placed and supervised.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
