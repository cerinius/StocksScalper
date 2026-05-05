"use client";

import { useState } from "react";
import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface AiHealth {
  enabled: boolean;
  ollamaReachable: boolean;
  ollamaModel: string;
  ollamaBaseUrl: string;
  failureRate5m: number;
  recentReviews: number;
  circuitOpen: boolean;
  byKind: Record<string, {
    count: number;
    p50: number;
    p95: number;
    avgMs: number;
  }>;
}

interface RecentReview {
  id: string;
  kind: string;
  model: string;
  promptVersion: string;
  verdict: string;
  confidence: number;
  latencyMs: number;
  safetyFiltered: boolean;
  createdAt: string;
}

interface NlqResult {
  question: string;
  answer: string;
  sources: Array<{ type: string; id: string; label: string }>;
  caveats: string[];
  latencyMs: number;
  model: string;
}

export default function AiPage() {
  const { data: health } = useSWR<AiHealth>("/api/ai/health", fetcher, { refreshInterval: 10_000 });
  const { data: reviews } = useSWR<RecentReview[]>("/api/ai/reviews?limit=20", fetcher, { refreshInterval: 15_000 });

  const [question, setQuestion] = useState("");
  const [nlqResult, setNlqResult] = useState<NlqResult | null>(null);
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqError, setNlqError] = useState<string | null>(null);

  const handleAsk = async () => {
    if (!question.trim()) return;
    setNlqLoading(true);
    setNlqError(null);
    setNlqResult(null);
    try {
      const resp = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as NlqResult;
      setNlqResult(data);
    } catch (err) {
      setNlqError((err as Error).message);
    } finally {
      setNlqLoading(false);
    }
  };

  return (
    <>
      <ScreenHeader
        eyebrow="AI"
        title="AI health and explainability"
        description="Monitor Ollama connectivity, call latency, safety filter rate, and circuit breaker status. AI is advisory only — the deterministic engine is the sole authority."
      />

      <div className="metrics-grid">
        <MetricCard
          label="Status"
          value={health?.enabled ? (health.ollamaReachable ? "Online" : "Offline") : "Disabled"}
          tone={health?.enabled && health?.ollamaReachable ? "good" : "critical"}
        />
        <MetricCard
          label="Circuit"
          value={health?.circuitOpen ? "OPEN" : "Closed"}
          tone={health?.circuitOpen ? "critical" : "good"}
        />
        <MetricCard label="Model" value={health?.ollamaModel ?? "—"} />
        <MetricCard
          label="Failure rate (5m)"
          value={`${(health?.failureRate5m ?? 0).toFixed(1)}%`}
          tone={(health?.failureRate5m ?? 0) > 10 ? "warn" : "default"}
        />
        <MetricCard label="Reviews (5m)" value={health?.recentReviews ?? 0} />
      </div>

      {health?.byKind && Object.keys(health.byKind).length > 0 && (
        <Panel title="Latency by kind (last hour)">
          <table className="data-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Count</th>
                <th>Avg</th>
                <th>p50</th>
                <th>p95</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(health.byKind).map(([kind, stats]) => (
                <tr key={kind}>
                  <td style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{kind}</td>
                  <td>{stats.count}</td>
                  <td>{stats.avgMs.toFixed(0)}ms</td>
                  <td>{stats.p50}ms</td>
                  <td>
                    <span style={{ color: stats.p95 > 5000 ? "var(--color-critical, #dc2626)" : "inherit" }}>
                      {stats.p95}ms
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Natural-language query" subtitle="Ask questions about your trading data. AI answers using structured DB retrieval — not hallucination.">
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAsk()}
            placeholder="e.g. Which symbols had the most losses this week?"
            style={{ flex: 1, padding: "0.5rem 0.75rem", borderRadius: 6, border: "1px solid var(--color-border, #e5e7eb)" }}
          />
          <button
            onClick={handleAsk}
            disabled={nlqLoading || !question.trim()}
            style={{ padding: "0.5rem 1rem", borderRadius: 6, cursor: "pointer" }}
          >
            {nlqLoading ? "Asking…" : "Ask"}
          </button>
        </div>

        {nlqError && (
          <div style={{ color: "var(--color-critical, #dc2626)", marginBottom: "1rem" }}>
            Error: {nlqError}
          </div>
        )}

        {nlqResult && (
          <div style={{ padding: "1rem", background: "var(--color-surface-2, #f9fafb)", borderRadius: 8 }}>
            <p style={{ marginBottom: "0.5rem", fontWeight: 500 }}>Answer</p>
            <p style={{ marginBottom: "1rem" }}>{nlqResult.answer}</p>
            {nlqResult.caveats.length > 0 && (
              <p style={{ fontSize: "0.85em", opacity: 0.7 }}>
                ⚠ {nlqResult.caveats.join(" · ")}
              </p>
            )}
            <p style={{ fontSize: "0.75em", opacity: 0.5, marginTop: "0.5rem" }}>
              {nlqResult.model} · {nlqResult.latencyMs}ms
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Recent AI calls" subtitle="Last 20 AI review calls across all kinds.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Model</th>
              <th>Verdict</th>
              <th>Confidence</th>
              <th>Latency</th>
              <th>Safety</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {(reviews ?? []).map((r) => (
              <tr key={r.id}>
                <td style={{ fontFamily: "monospace", fontSize: "0.8em" }}>{r.kind}</td>
                <td style={{ fontSize: "0.8em" }}>{r.model}</td>
                <td>
                  <StatusPill
                    tone={r.verdict === "APPROVE" ? "good" : r.verdict === "OBJECT" || r.verdict === "SUGGEST_CLOSE" ? "critical" : "warn"}
                    label={r.verdict}
                  />
                </td>
                <td>{r.confidence.toFixed(0)}%</td>
                <td style={{ color: r.latencyMs > 5000 ? "var(--color-critical, #dc2626)" : "inherit" }}>
                  {r.latencyMs}ms
                </td>
                <td>
                  {r.safetyFiltered ? (
                    <StatusPill tone="warn" label="filtered" />
                  ) : (
                    <StatusPill tone="good" label="clean" />
                  )}
                </td>
                <td>{formatDateTime(r.createdAt)}</td>
              </tr>
            ))}
            {(reviews ?? []).length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", opacity: 0.5 }}>
                  No AI calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
