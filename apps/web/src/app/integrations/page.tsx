"use client";

import { useTransition } from "react";
import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { apiBase, fetcher } from "../../lib/api";

interface IntegrationsResponseItem {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  statuses: Array<{ status: string; summary: string; updatedAt: string }>;
}

async function post(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

export default function IntegrationsPage() {
  const { data, mutate } = useSWR<IntegrationsResponseItem[]>("/api/integrations", fetcher, { refreshInterval: 15_000 });
  const [pending, startTransition] = useTransition();

  const runAction = (path: string, body?: Record<string, unknown>) => {
    startTransition(async () => {
      await post(path, body);
      await mutate();
    });
  };

  return (
    <>
      <ScreenHeader
        eyebrow="Integrations"
        title="Broker, signal, and notification connectivity"
        description="Manage MT5 adapter state, TradingView ingestion readiness, and Discord delivery configuration."
        actions={
          <div className="button-row">
            <button className="button" disabled={pending} onClick={() => runAction("/api/integrations/mt5/connect", { server: "local", login: "paper", password: "paper", mode: "paper" })}>
              Connect MT5
            </button>
            <button className="button secondary" disabled={pending} onClick={() => runAction("/api/integrations/mt5/disconnect")}>
              Disconnect
            </button>
            <button className="button secondary" disabled={pending} onClick={() => runAction("/api/integrations/mt5/sync")}>
              Sync
            </button>
          </div>
        }
      />
      <Panel title="Integration status" subtitle="Current backend connectivity and config health.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Enabled</th>
              <th>Latest Status</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.kind}</td>
                <td><StatusPill value={item.enabled ? "enabled" : "disabled"} /></td>
                <td><StatusPill value={item.statuses[0]?.status ?? "unknown"} /></td>
                <td>{item.statuses[0]?.summary ?? "No status yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
