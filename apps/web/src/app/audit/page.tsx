"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface AuditItem {
  id: string;
  category: string;
  message: string;
  severity: string;
  actorType: string;
  createdAt: string;
  symbol?: { ticker: string } | null;
}

export default function AuditPage() {
  const { data } = useSWR<AuditItem[]>("/api/audit?limit=60", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Audit"
        title="Chronological system journal"
        description="Every meaningful action in the platform is meant to be explainable. This feed is the spine of that promise."
      />
      <Panel title="Audit trail" subtitle="Worker actions, control changes, webhook events, and system observations.">
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Severity</th>
              <th>Actor</th>
              <th>Category</th>
              <th>Symbol</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((item) => (
              <tr key={item.id}>
                <td>{formatDateTime(item.createdAt)}</td>
                <td><StatusPill value={item.severity} /></td>
                <td>{item.actorType}</td>
                <td>{item.category}</td>
                <td>{item.symbol?.ticker ?? "-"}</td>
                <td>{item.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
