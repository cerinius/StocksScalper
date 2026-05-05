"use client";

import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface AiLesson {
  id: string;
  sourceKind: string;
  title: string;
  detail: string;
  tags: string[];
  weight: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  accountId: string | null;
  account: { id: string; label: string } | null;
}

interface LessonsResponse {
  rows: AiLesson[];
  total: number;
}

export default function LessonsPage() {
  const { data } = useSWR<LessonsResponse>("/api/lessons?limit=100&active=true", fetcher, { refreshInterval: 60_000 });

  const lessons = data?.rows ?? [];

  const bySource = lessons.reduce<Record<string, number>>((acc, l) => {
    acc[l.sourceKind] = (acc[l.sourceKind] ?? 0) + 1;
    return acc;
  }, {});

  const highPriority = lessons.filter((l) => l.weight >= 0.7).length;

  return (
    <>
      <ScreenHeader
        eyebrow="Lessons"
        title="Lessons learned"
        description="Lessons extracted by AI from post-trade reviews and weekly synthesis. These are fed back into future pre-trade critiques as context."
      />

      <div className="metrics-grid">
        <MetricCard label="Active lessons" value={data?.total ?? 0} />
        <MetricCard label="From post-trade" value={bySource["POST_TRADE"] ?? 0} />
        <MetricCard label="From weekly" value={bySource["WEEKLY"] ?? 0} />
        <MetricCard label="Manual" value={bySource["MANUAL"] ?? 0} />
        <MetricCard label="High priority" value={highPriority} tone={highPriority > 0 ? "warn" : "default"} />
      </div>

      <Panel title="Active lessons" subtitle="Sorted by priority (weight). Lessons feed into future AI pre-trade critiques.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Account</th>
              <th>Source</th>
              <th>Priority</th>
              <th>Tags</th>
              <th>Detail</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {lessons.map((l) => (
              <tr key={l.id}>
                <td style={{ fontWeight: 500 }}>{l.title}</td>
                <td>{l.account?.label ?? "Portfolio"}</td>
                <td>
                  <StatusPill
                    tone={l.sourceKind === "MANUAL" ? "default" : l.sourceKind === "WEEKLY" ? "warn" : "good"}
                    label={l.sourceKind.toLowerCase().replace("_", "-")}
                  />
                </td>
                <td>
                  <StatusPill
                    tone={l.weight >= 0.7 ? "critical" : l.weight >= 0.5 ? "warn" : "default"}
                    label={l.weight >= 0.7 ? "high" : l.weight >= 0.5 ? "medium" : "low"}
                  />
                </td>
                <td style={{ fontSize: "0.8em" }}>
                  {Array.isArray(l.tags) ? l.tags.join(", ") : "—"}
                </td>
                <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.detail}
                </td>
                <td>{formatDateTime(l.createdAt)}</td>
              </tr>
            ))}
            {lessons.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", opacity: 0.5 }}>
                  No lessons yet. Lessons are extracted from post-trade AI reviews and weekly synthesis.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
