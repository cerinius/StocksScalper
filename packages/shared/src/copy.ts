/**
 * Centralised copy for status labels, empty states, toast messages, etc.
 *
 * Any string that appears in the UI should live here or come from a
 * {@link DecisionRecord}. This keeps terminology consistent everywhere and
 * makes future localisation a simple exercise.
 */

export const CANDIDATE_STATUS_LABELS: Record<string, { label: string; description: string; tone: Tone }> = {
  NEW: {
    label: "New",
    description: "Newly detected. Queued for validation.",
    tone: "info",
  },
  SCANNED: {
    label: "Scanned",
    description: "Screening complete. Awaiting analog backtest.",
    tone: "info",
  },
  VALIDATING: {
    label: "Validating",
    description: "Historical analogs are being analysed.",
    tone: "info",
  },
  VALIDATED: {
    label: "Validated",
    description: "Historical analogs support this setup.",
    tone: "good",
  },
  REJECTED: {
    label: "Rejected",
    description: "Validation or a risk gate did not clear.",
    tone: "critical",
  },
  EXECUTED: {
    label: "Executed",
    description: "Order sent to the broker.",
    tone: "good",
  },
  CLOSED: {
    label: "Closed",
    description: "Position exited.",
    tone: "neutral",
  },
  INVALIDATED: {
    label: "Invalidated",
    description: "Setup aged out or a precondition broke.",
    tone: "warn",
  },
};

export const VALIDATION_STATUS_LABELS: Record<string, { label: string; description: string; tone: Tone }> = {
  PENDING: { label: "Running", description: "Analog backtest is in progress.", tone: "info" },
  PASSED: { label: "Passed", description: "Historical analogs support this setup.", tone: "good" },
  FAILED: { label: "Failed", description: "Not enough historical support to trade this.", tone: "critical" },
  STALE: { label: "Stale", description: "Market has moved since this was validated.", tone: "warn" },
};

export const EXECUTION_ACTION_LABELS: Record<string, { label: string; description: string; tone: Tone }> = {
  PLACE: { label: "Place", description: "Submit a real order to the broker.", tone: "good" },
  HOLD: { label: "Hold", description: "Monitor, but do not enter yet.", tone: "info" },
  SKIP: { label: "Skip", description: "A pre-trade check blocked this entry.", tone: "warn" },
  CLOSE: { label: "Close", description: "Exit the existing position.", tone: "neutral" },
  REDUCE: { label: "Reduce", description: "Trim the existing position.", tone: "neutral" },
  INVALIDATE: { label: "Invalidate", description: "Cancel and retire this setup.", tone: "warn" },
};

export const EXECUTION_DECISION_STATUS_LABELS: Record<string, { label: string; description: string; tone: Tone }> = {
  PROPOSED: { label: "Proposed", description: "Awaiting approval or next stage.", tone: "info" },
  APPROVED: { label: "Approved", description: "Cleared to send.", tone: "good" },
  SENT: { label: "Sent", description: "Transmitted to the broker.", tone: "info" },
  APPLIED: { label: "Filled", description: "Order was filled.", tone: "good" },
  REJECTED: { label: "Rejected", description: "The broker refused the order.", tone: "critical" },
  SIMULATED: { label: "Simulated", description: "Paper trade only. No real order was sent.", tone: "neutral" },
};

export const ORDER_STATUS_LABELS: Record<string, { label: string; description: string; tone: Tone }> = {
  PENDING: { label: "Pending", description: "Order built, not yet sent.", tone: "info" },
  SUBMITTED: { label: "Submitted", description: "Sent to the broker.", tone: "info" },
  FILLED: { label: "Filled", description: "Order executed.", tone: "good" },
  REJECTED: { label: "Rejected", description: "Broker refused the order.", tone: "critical" },
  CANCELED: { label: "Cancelled", description: "Cancelled before fill.", tone: "warn" },
};

export const SEVERITY_LABELS: Record<string, { label: string; tone: Tone }> = {
  INFO: { label: "Info", tone: "info" },
  WARNING: { label: "Warning", tone: "warn" },
  CRITICAL: { label: "Critical", tone: "critical" },
};

export type Tone = "info" | "good" | "warn" | "critical" | "neutral";

export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  candidate_created: "Idea created",
  candidate_updated: "Idea updated",
  validation_started: "Validation started",
  validation_passed: "Validation passed",
  validation_failed: "Validation failed",
  execution_decision: "Execution decision",
  execution_skipped: "Execution skipped",
  execution_entered: "Execution entered",
  execution_invalidated: "Execution invalidated",
  order_submitted: "Order submitted",
  order_filled: "Order filled",
  order_rejected: "Order rejected",
  risk_event: "Risk event",
  kill_switch_toggled: "Kill switch toggled",
  worker_heartbeat_missed: "Worker heartbeat missed",
  webhook_received: "Webhook received",
};

export const formatAuditCategory = (category: string): string =>
  AUDIT_CATEGORY_LABELS[category] ??
  category
    .split(/[._-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export const getStatusLabel = (
  map: Record<string, { label: string; description: string; tone: Tone }>,
  value: string | null | undefined,
): { label: string; description: string; tone: Tone } => {
  if (!value) return { label: "—", description: "No status recorded.", tone: "neutral" };
  return map[value] ?? { label: value, description: "", tone: "neutral" };
};
