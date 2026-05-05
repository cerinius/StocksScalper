"use client";

import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

export interface ColumnDef<TRow> {
  key: string;
  header: ReactNode;
  /** Render the cell for this column. */
  render(_row: TRow): ReactNode;
  /** Whether this column supports click-to-sort. */
  sortable?: boolean;
  /** Sort field name to emit (defaults to `key`). */
  sortField?: string;
  /** Tailwind / CSS width hint. */
  width?: string;
  /** Align the header + cells. */
  align?: "left" | "right" | "center";
  /** Hide on narrower screens (<= 900px). */
  collapseOnNarrow?: boolean;
}

export interface DataTableProps<TRow> {
  columns: ColumnDef<TRow>[];
  rows: TRow[];
  getRowKey(_row: TRow): string;
  /** Called when the user clicks on a sortable column header. */
  onSortChange?(_field: string, _direction: "asc" | "desc"): void;
  sort?: { field: string; direction: "asc" | "desc" };
  /** Optional expanded row content, rendered below the row when clicked. */
  renderExpanded?(_row: TRow): ReactNode;
  emptyState?: ReactNode;
  /** Extra className for outer container. */
  className?: string;
  /** Stickify the header while scrolling. */
  stickyHeader?: boolean;
}

/**
 * Lightweight data table with optional per-row expansion, stable
 * column-definition-driven rendering, and sort-click routing.
 *
 * Designed to work with the platform `ListEnvelope` pattern: the parent
 * owns pagination, filters, and sort state; this component just renders.
 */
export function DataTable<TRow>({
  columns,
  rows,
  getRowKey,
  onSortChange,
  sort,
  renderExpanded,
  emptyState,
  className,
  stickyHeader = true,
}: DataTableProps<TRow>) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  const renderedColumns = useMemo(() => columns, [columns]);

  if (rows.length === 0 && emptyState) {
    return <div className="data-table-empty">{emptyState}</div>;
  }

  return (
    <div className={`data-table-wrap ${className ?? ""}`.trim()}>
      <table className={`data-table ${stickyHeader ? "sticky-head" : ""}`.trim()}>
        <thead>
          <tr>
            {renderExpanded ? <th className="expand-col" aria-label="Expand" /> : null}
            {renderedColumns.map((col) => {
              const isActive = sort?.field === (col.sortField ?? col.key);
              const arrow = isActive ? (sort?.direction === "asc" ? " ▲" : " ▼") : "";
              return (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={[col.align ? `align-${col.align}` : "", col.collapseOnNarrow ? "collapse-narrow" : ""]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className={`sort-btn ${isActive ? "active" : ""}`.trim()}
                      onClick={() => {
                        const field = col.sortField ?? col.key;
                        const nextDir: "asc" | "desc" = isActive && sort?.direction === "desc" ? "asc" : "desc";
                        onSortChange?.(field, nextDir);
                      }}
                    >
                      {col.header}
                      <span className="sort-arrow">{arrow}</span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowKey = getRowKey(row);
            const isExpanded = expanded.has(rowKey);
            return (
              <>
                <tr
                  key={rowKey}
                  className={renderExpanded ? "expandable" : ""}
                  onClick={renderExpanded ? () => toggle(rowKey) : undefined}
                >
                  {renderExpanded ? (
                    <td className="expand-col">
                      <span className={`chevron ${isExpanded ? "open" : ""}`.trim()}>▸</span>
                    </td>
                  ) : null}
                  {renderedColumns.map((col) => (
                    <td
                      key={col.key}
                      className={[col.align ? `align-${col.align}` : "", col.collapseOnNarrow ? "collapse-narrow" : ""]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
                {isExpanded && renderExpanded ? (
                  <tr key={`${rowKey}-expanded`} className="expanded-row">
                    <td colSpan={renderedColumns.length + 1}>{renderExpanded(row)}</td>
                  </tr>
                ) : null}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
