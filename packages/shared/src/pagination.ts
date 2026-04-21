/**
 * Standard envelope shape returned by every list endpoint in the platform.
 *
 * The convention is deliberately strict so the frontend can build generic
 * table / filter / pagination components without knowing the row type.
 */
export interface ListMeta {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasMore: boolean;
  /** ISO timestamp the server generated this page at. */
  generatedAt: string;
  /** Applied filters, echoed back so the UI can display them. */
  appliedFilters: Record<string, string | string[] | number | boolean | null>;
  /** Sort key and direction actually used. */
  sort: { field: string; direction: "asc" | "desc" };
  /**
   * Present only when the result is empty. Gives the UI a reason to show.
   * Examples: "no_matches", "no_data_yet", "filter_too_narrow".
   */
  emptyReason?: EmptyReason;
  /** Human-readable sentence paired with emptyReason. */
  emptyMessage?: string;
}

export type EmptyReason =
  | "no_data_yet"
  | "no_matches"
  | "filter_too_narrow"
  | "date_range_empty"
  | "loading_failed";

export interface ListEnvelope<T> {
  items: T[];
  meta: ListMeta;
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  direction?: "asc" | "desc";
}

/** Parse and clamp a pagination query, always returning safe values. */
export const parseListQuery = (
  raw: Record<string, string | undefined>,
  defaults: { pageSize?: number; maxPageSize?: number; sort?: string; direction?: "asc" | "desc" } = {},
): Required<ListQuery> => {
  const pageSize = clampInt(raw.pageSize, defaults.pageSize ?? 25, 1, defaults.maxPageSize ?? 200);
  const page = clampInt(raw.page, 1, 1, 10_000);
  const sort = raw.sort?.trim() || defaults.sort || "createdAt";
  const directionRaw = (raw.direction ?? defaults.direction ?? "desc").toLowerCase();
  const direction = directionRaw === "asc" ? "asc" : "desc";
  return { page, pageSize, sort, direction };
};

const clampInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export const buildListEnvelope = <T>(args: {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  sort: { field: string; direction: "asc" | "desc" };
  appliedFilters?: Record<string, string | string[] | number | boolean | null>;
  emptyReason?: EmptyReason;
  emptyMessage?: string;
}): ListEnvelope<T> => {
  const pageCount = args.pageSize > 0 ? Math.max(1, Math.ceil(args.total / args.pageSize)) : 1;
  return {
    items: args.items,
    meta: {
      total: args.total,
      page: args.page,
      pageSize: args.pageSize,
      pageCount,
      hasMore: args.page < pageCount,
      generatedAt: new Date().toISOString(),
      appliedFilters: args.appliedFilters ?? {},
      sort: args.sort,
      emptyReason: args.items.length === 0 ? args.emptyReason ?? "no_matches" : undefined,
      emptyMessage:
        args.items.length === 0
          ? args.emptyMessage ?? defaultEmptyMessage(args.emptyReason ?? "no_matches")
          : undefined,
    },
  };
};

export const defaultEmptyMessage = (reason: EmptyReason): string => {
  switch (reason) {
    case "no_data_yet":
      return "Nothing has been recorded yet. New items will appear here as the system produces them.";
    case "no_matches":
      return "No records match the current filters. Try clearing filters or widening the date range.";
    case "filter_too_narrow":
      return "Your filter combination is too narrow. Remove one filter and try again.";
    case "date_range_empty":
      return "There is no activity in the selected date range.";
    case "loading_failed":
      return "We couldn't load this list. Try the refresh button in the top right.";
  }
};
