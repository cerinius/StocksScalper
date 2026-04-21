"use client";

import type { ReactNode } from "react";
import { describeEmptyReason, type ListMeta } from "../lib/api";

export interface EmptyStateProps {
  /** The server-provided reason, if any. */
  reason?: ListMeta["emptyReason"];
  /** Optional custom message (overrides the default for the reason). */
  message?: string | null;
  /** Title shown above the explanation. Defaults to a context-aware sentence. */
  title?: string;
  actions?: ReactNode;
  /** Show a subtle debug block in development mode. */
  debug?: Record<string, unknown>;
}

/**
 * Professional empty-state card for lists.
 *
 * The platform now distinguishes "no data yet" (pipeline has produced
 * nothing) from "no matches" (filters are hiding everything). Surfacing
 * this distinction is one of the single biggest UX wins — it is the main
 * reason operators used to think "new ideas are broken" when really they
 * had a stale filter applied.
 */
export function EmptyState({ reason, message, title, actions, debug }: EmptyStateProps) {
  const headline = title ?? inferTitle(reason);
  const description = describeEmptyReason(reason, message);
  const showDebug = debug && process.env.NODE_ENV !== "production";
  return (
    <div className={`empty-state reason-${reason ?? "unknown"}`}>
      <div className="empty-state-icon" aria-hidden>
        {reason === "loading_failed" ? "⚠" : reason === "no_data_yet" ? "🕓" : "∅"}
      </div>
      <h3 className="empty-state-title">{headline}</h3>
      <p className="empty-state-body">{description}</p>
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
      {showDebug ? (
        <details className="empty-state-debug">
          <summary>Debug</summary>
          <pre>{JSON.stringify(debug, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

const inferTitle = (reason: ListMeta["emptyReason"]): string => {
  switch (reason) {
    case "no_data_yet":
      return "Nothing recorded yet";
    case "no_matches":
      return "No matches";
    case "filter_too_narrow":
      return "Filters too narrow";
    case "date_range_empty":
      return "No activity in this range";
    case "loading_failed":
      return "Couldn't load data";
    default:
      return "No results";
  }
};
