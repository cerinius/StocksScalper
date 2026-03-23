"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface NotificationResponse {
  notifications: Array<{
    id: string;
    category: string;
    severity: string;
    status: string;
    title: string;
    body: string;
    retryCount: number;
    createdAt: string;
    deliveredAt: string | null;
  }>;
  templates: Array<{ id: string; key: string; enabled: boolean; severity: string }>;
}

export default function NotificationsPage() {
  const { data } = useSWR<NotificationResponse>("/api/notifications?limit=40", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Notifications"
        title="Discord delivery and alert history"
        description="Track what the platform attempted to send, what succeeded, and which templates are active."
      />
      <Panel title="Notification history" subtitle="Structured alert categories, severity, and delivery status.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Status</th>
              <th>Severity</th>
              <th>Category</th>
              <th>Title</th>
              <th>Retries</th>
              <th>Delivered</th>
            </tr>
          </thead>
          <tbody>
            {(data?.notifications ?? []).map((item) => (
              <tr key={item.id}>
                <td>{formatDateTime(item.createdAt)}</td>
                <td><StatusPill value={item.status} /></td>
                <td><StatusPill value={item.severity} /></td>
                <td>{item.category}</td>
                <td>{item.title}</td>
                <td>{item.retryCount}</td>
                <td>{formatDateTime(item.deliveredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Templates" subtitle="Configured message templates and default severity.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Enabled</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {(data?.templates ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.key}</td>
                <td><StatusPill value={item.enabled ? "enabled" : "disabled"} /></td>
                <td>{item.severity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
