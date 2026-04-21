"use client";

import type { ReactNode } from "react";

export interface StructuredReason {
  code: string;
  category: string;
  severity: "info" | "notice" | "warning" | "critical";
  title: string;
  explanation: string;
  observed?: Record<string, unknown> | null;
  expected?: Record<string, unknown> | null;
  remediation?: string | null;
  userFacing?: boolean;
  tags?: string[];
  at?: string;
}

const severityTone = (severity: StructuredReason["severity"]): "info" | "warn" | "critical" | "neutral" => {
  switch (severity) {
    case "critical":
      return "critical";
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "notice":
    default:
      return "neutral";
  }
};

const describeValues = (values: Record<string, unknown> | null | undefined): string | null => {
  if (!values) return null;
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) => {
      if (value === null || value === undefined) return `${key}: —`;
      if (typeof value === "number") return `${key}: ${Number.isInteger(value) ? value : value.toFixed(2)}`;
      return `${key}: ${String(value)}`;
    })
    .join(" · ");
};

/**
 * Render a single structured decision reason as a professional, scannable
 * card: title pill (severity-tone), one-sentence explanation, observed vs
 * expected values, optional remediation, and a small timestamp footer.
 */
export function ReasonCard({ reason, footer }: { reason: StructuredReason; footer?: ReactNode }) {
  const tone = severityTone(reason.severity);
  const observed = describeValues(reason.observed);
  const expected = describeValues(reason.expected);
  return (
    <article className={`reason-card tone-${tone}`}>
      <header className="reason-card-head">
        <span className={`severity-pill tone-${tone}`}>{reason.severity}</span>
        <h3 className="reason-card-title">{reason.title}</h3>
        <code className="reason-card-code" title="Machine reason code">
          {reason.code}
        </code>
      </header>
      <p className="reason-card-explanation">{reason.explanation}</p>
      {observed ? (
        <div className="reason-card-metrics">
          <span className="eyebrow">Observed</span>
          <span>{observed}</span>
        </div>
      ) : null}
      {expected ? (
        <div className="reason-card-metrics">
          <span className="eyebrow">Required</span>
          <span>{expected}</span>
        </div>
      ) : null}
      {reason.remediation ? (
        <div className="reason-card-remediation">
          <span className="eyebrow">What would help</span>
          <span>{reason.remediation}</span>
        </div>
      ) : null}
      {reason.tags && reason.tags.length > 0 ? (
        <div className="reason-card-tags">
          {reason.tags.map((tag) => (
            <span key={tag} className="reason-card-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {footer ? <footer className="reason-card-footer">{footer}</footer> : null}
    </article>
  );
}

export function ReasonList({ reasons, emptyMessage }: { reasons: StructuredReason[]; emptyMessage?: string }) {
  if (!reasons || reasons.length === 0) {
    return <p className="reason-list-empty">{emptyMessage ?? "No reasons recorded."}</p>;
  }
  return (
    <div className="reason-list">
      {reasons.map((reason, index) => (
        <ReasonCard key={`${reason.code}-${index}`} reason={reason} />
      ))}
    </div>
  );
}

/**
 * Compact pill used inline in tables to show the most-important single
 * reason (for example, the primary blocker on an execution row).
 */
export function ReasonPill({ reason }: { reason: StructuredReason }) {
  const tone = severityTone(reason.severity);
  return (
    <span className={`reason-pill tone-${tone}`} title={reason.explanation}>
      {reason.title}
    </span>
  );
}
