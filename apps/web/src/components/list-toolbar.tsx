"use client";

import type { ReactNode } from "react";
import { formatRelativeTime, type ListMeta } from "../lib/api";

export interface ListToolbarProps {
  title: string;
  /** Optional short sentence shown under the title. */
  description?: string;
  /** Server-provided list metadata — used for "last updated" and counts. */
  meta?: ListMeta | null;
  /** Is the data currently being revalidated. */
  isLoading?: boolean;
  /** Callback for the "refresh" action. */
  onRefresh?: () => void;
  /** Extra slots on the right side of the toolbar. */
  actions?: ReactNode;
  /** Filter chips / controls row. */
  filters?: ReactNode;
  /** Pagination controls, rendered below the filters. */
  pagination?: ReactNode;
}

/**
 * Toolbar shown above every list/table. Provides a consistent place for
 * the title, "last updated" signal, total count, refresh button, filter
 * controls, and pagination.
 *
 * Rendering the `generatedAt` from the envelope meta is the single most
 * important debugging affordance: if it stops updating, the pipeline is
 * stuck. That was the "new ideas are not showing" root cause; the fix is
 * to always surface it so an operator sees the staleness immediately.
 */
export function ListToolbar({
  title,
  description,
  meta,
  isLoading,
  onRefresh,
  actions,
  filters,
  pagination,
}: ListToolbarProps) {
  const total = meta?.total ?? 0;
  const pageStart = meta ? (meta.page - 1) * meta.pageSize + 1 : 0;
  const pageEnd = meta ? Math.min(meta.page * meta.pageSize, meta.total) : 0;
  const lastUpdated = meta?.generatedAt;

  return (
    <div className="list-toolbar">
      <div className="list-toolbar-head">
        <div>
          <h2 className="list-toolbar-title">{title}</h2>
          {description ? <p className="list-toolbar-desc">{description}</p> : null}
        </div>
        <div className="list-toolbar-actions">
          {meta && total > 0 ? (
            <span className="list-toolbar-count">
              {pageStart}–{pageEnd} of {total.toLocaleString()}
            </span>
          ) : null}
          {lastUpdated ? (
            <span className="list-toolbar-updated" title={new Date(lastUpdated).toLocaleString()}>
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label="Refresh list"
            >
              {isLoading ? "Refreshing…" : "Refresh"}
            </button>
          ) : null}
          {actions}
        </div>
      </div>
      {filters ? <div className="list-toolbar-filters">{filters}</div> : null}
      {pagination ? <div className="list-toolbar-pagination">{pagination}</div> : null}
    </div>
  );
}

export interface PaginationControlsProps {
  meta: ListMeta | null | undefined;
  onPageChange(_page: number): void;
  onPageSizeChange?(_size: number): void;
  pageSizeOptions?: number[];
}

export function PaginationControls({
  meta,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200],
}: PaginationControlsProps) {
  if (!meta) return null;
  const canPrev = meta.page > 1;
  const canNext = meta.page < meta.pageCount;
  return (
    <div className="pagination-controls">
      <div className="pagination-page">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onPageChange(1)}
          disabled={!canPrev}
          aria-label="First page"
        >
          « First
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onPageChange(meta.page - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
        >
          ‹ Prev
        </button>
        <span className="pagination-summary">
          Page {meta.page} of {Math.max(1, meta.pageCount)}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onPageChange(meta.page + 1)}
          disabled={!canNext}
          aria-label="Next page"
        >
          Next ›
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onPageChange(meta.pageCount)}
          disabled={!canNext}
          aria-label="Last page"
        >
          Last »
        </button>
      </div>
      {onPageSizeChange ? (
        <label className="pagination-page-size">
          <span className="eyebrow">Rows</span>
          <select
            value={meta.pageSize}
            onChange={(event) => onPageSizeChange(Number(event.currentTarget.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
