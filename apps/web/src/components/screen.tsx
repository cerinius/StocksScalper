"use client";

import type { PropsWithChildren, ReactNode } from "react";

export function ScreenHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="screen-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="screen-actions">{actions}</div> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  tone = "default",
  meta,
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "good" | "warn" | "critical";
  meta?: ReactNode;
}) {
  return (
    <div className={`metric-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

export function Panel({ title, subtitle, children }: PropsWithChildren<{ title: string; subtitle?: string }>) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function StatusPill({ value }: { value: string }) {
  const tone = value.toLowerCase().includes("critical")
    ? "critical"
    : value.toLowerCase().includes("warning") || value.toLowerCase().includes("degraded")
      ? "warn"
      : value.toLowerCase().includes("open") || value.toLowerCase().includes("connected") || value.toLowerCase().includes("healthy")
        ? "good"
        : "default";

  return <span className={`status-pill tone-${tone}`}>{value}</span>;
}
