"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface ExecutionResponse {
  decisions: Array<{
    id: string;
    action: string;
    confidence: number;
    riskScore: number;
    evidenceSummary: string;
    createdAt: string;
    candidate: { symbol: { ticker: string }; strategyType: string };
  }>;
  orders: Array<{
    id: string;
    status: string;
    direction: string;
    quantity: number;
    entryPrice: number;
    createdAt: string;
    symbol: { ticker: string };
  }>;
  riskEvents: Array<{ id: string; severity: string; message: string; createdAt: string }>;
}

export default function ExecutionPage() {
  const { data } = useSWR<ExecutionResponse>("/api/execution?limit=30", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Execution"
        title="Decision engine and order flow"
        description="Review the structured outcome of the execution brain, recent order activity, and risk blocks."
      />

      <div className="panel-grid">
        <Panel title="Decision stream" subtitle="Structured actions emitted by the execution brain.">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Action</th>
                <th>Confidence</th>
                <th>Risk Score</th>
              </tr>
            </thead>
            <tbody>
              {(data?.decisions ?? []).map((decision) => (
                <tr key={decision.id}>
                  <td>{formatDateTime(decision.createdAt)}</td>
                  <td>{decision.candidate.symbol.ticker}</td>
                  <td><StatusPill value={decision.action} /></td>
                  <td>{decision.confidence.toFixed(1)}</td>
                  <td>{decision.riskScore.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Risk blocks" subtitle="Recent events that prevented or modified execution.">
          <div className="list-stack">
            {(data?.riskEvents ?? []).map((event) => (
              <div className="list-item" key={event.id}>
                <StatusPill value={event.severity} />
                <p>{event.message}</p>
                <small>{formatDateTime(event.createdAt)}</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Orders" subtitle="Latest order intents and fills from the MT5 adapter flow.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Status</th>
              <th>Direction</th>
              <th>Qty</th>
              <th>Entry</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(data?.orders ?? []).map((order) => (
              <tr key={order.id}>
                <td>{order.symbol.ticker}</td>
                <td><StatusPill value={order.status} /></td>
                <td>{order.direction}</td>
                <td>{order.quantity}</td>
                <td>{order.entryPrice.toFixed(2)}</td>
                <td>{formatDateTime(order.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
