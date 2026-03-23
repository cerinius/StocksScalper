export const parseLimit = (value: unknown, fallback = 25, max = 200) => {
  const numeric = typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, max);
};

export const parseOffset = (value: unknown, fallback = 0) => {
  const numeric = typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return numeric;
};
