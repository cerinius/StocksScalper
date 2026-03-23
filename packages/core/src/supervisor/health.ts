import type { AccountStateSnapshot, WorkerHealthSnapshot } from "@stock-radar/types";

export interface SupervisorAlert {
  severity: "info" | "warning" | "critical";
  summary: string;
}

export const summarizeWorkerHealth = (workers: WorkerHealthSnapshot[]): SupervisorAlert[] => {
  const alerts: SupervisorAlert[] = [];

  for (const worker of workers) {
    if (worker.status === "offline") {
      alerts.push({ severity: "critical", summary: `${worker.workerType} worker is offline.` });
      continue;
    }

    if (worker.status === "degraded" || worker.failureCount24h >= 3) {
      alerts.push({ severity: "warning", summary: `${worker.workerType} worker is degraded or retrying frequently.` });
    }
  }

  return alerts;
};

export const summarizeAccountRisk = (account: AccountStateSnapshot | null): SupervisorAlert[] => {
  if (!account) {
    return [{ severity: "warning", summary: "No account snapshot is available yet." }];
  }

  const alerts: SupervisorAlert[] = [];

  if (account.killSwitchActive) {
    alerts.push({ severity: "critical", summary: "Kill switch is active." });
  }

  if (account.drawdownPct >= 2) {
    alerts.push({ severity: "warning", summary: `Daily drawdown is elevated at ${account.drawdownPct.toFixed(2)}%.` });
  }

  return alerts;
};
