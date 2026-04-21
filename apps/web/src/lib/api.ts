"use client";

export const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4210";

export async function fetcher<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${path}`);
  }

  return (await response.json()) as T;
}

/**
 * Shape of every paginated list the API returns. This mirrors the
 * `ListEnvelope<T>` produced by `buildListEnvelope` on the backend.
 */
export interface ListMeta {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasMore: boolean;
  generatedAt: string;
  appliedFilters?: Record<string, unknown>;
  sort?: { field: string; direction: "asc" | "desc" };
  emptyReason?: "no_data_yet" | "no_matches" | "filter_too_narrow" | "date_range_empty" | "loading_failed" | null;
  emptyMessage?: string | null;
}

export interface ListEnvelope<T> {
  items: T[];
  meta: ListMeta;
}

/**
 * Build a querystring from a flat key/value map, skipping blanks and
 * arrays-as-commas. Used everywhere we need to hydrate filters from URL state.
 */
export const toQueryString = (params: Record<string, unknown>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      const filtered = value.filter((v) => v !== null && v !== undefined && v !== "");
      if (filtered.length === 0) continue;
      search.set(key, filtered.join(","));
      continue;
    }
    search.set(key, String(value));
  }
  const str = search.toString();
  return str.length > 0 ? `?${str}` : "";
};

export const formatMoney = (value: number | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value ?? 0);

export const formatPercent = (value: number | null | undefined) => `${(value ?? 0).toFixed(2)}%`;

export const formatDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "N/A";

export const formatRelativeTime = (value: string | null | undefined) => {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

/** Human-readable sentence for an empty-envelope state. */
export const describeEmptyReason = (reason: ListMeta["emptyReason"], customMessage?: string | null): string => {
  if (customMessage) return customMessage;
  switch (reason) {
    case "no_data_yet":
      return "Nothing has been recorded here yet. New entries will appear automatically.";
    case "no_matches":
      return "No records match the current filters. Try broadening the search.";
    case "filter_too_narrow":
      return "Filters are too narrow — relax at least one to see results.";
    case "date_range_empty":
      return "No activity in the selected date range.";
    case "loading_failed":
      return "The request failed while loading. Use the refresh button to try again.";
    default:
      return "No results.";
  }
};
