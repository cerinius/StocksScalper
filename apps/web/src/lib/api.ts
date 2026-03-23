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

export const formatMoney = (value: number | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value ?? 0);

export const formatPercent = (value: number | null | undefined) => `${(value ?? 0).toFixed(2)}%`;

export const formatDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "N/A";
