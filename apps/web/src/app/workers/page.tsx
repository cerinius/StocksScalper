"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface WorkersResponse {
  workers: Array<{
    workerType: string;
    status: string;
    currentTask: string | null;
    lagMs: number;
    lastSeenAt: string;
    lastRun: { status: string; startedAt: string; resultSummary: string | null } | null;
    recentFailures: Array<{ id: string; errorMessage: string; occurredAt: string }>;
  }>;
}

export default function WorkersPage() {
  const { data } = useSWR<WorkersResponse>("/api/workers", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Workers"
        title="Autonomous worker fleet"
        description="Track health, lag, retries, and the latest completed task for each worker service."
      />
      <Panel title="Worker Overview" subtitle="Heartbeat, recent runs, and failure visibility.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Status</th>
              <th>Current Task</th>
              <th>Lag</th>
              <th>Last Seen</th>
              <th>Last Run</th>
              <th>Recent Failure</th>
            </tr>
          </thead>
          <tbody>
            {(data?.workers ?? []).map((worker) => (
              <tr key={worker.workerType}>
                <td>{worker.workerType}</td>
                <td><StatusPill value={worker.status} /></td>
                <td>{worker.currentTask ?? "idle"}</td>
                <td>{worker.lagMs}ms</td>
                <td>{formatDateTime(worker.lastSeenAt)}</td>
                <td>{worker.lastRun ? `${worker.lastRun.status} at ${formatDateTime(worker.lastRun.startedAt)}` : "N/A"}</td>
                <td>{worker.recentFailures[0]?.errorMessage ?? "No recent failure"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
