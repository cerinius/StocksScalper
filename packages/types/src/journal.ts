import { z } from "zod";

/**
 * Vault export status — every derived markdown note in the Obsidian
 * vault corresponds to one of these entries.
 */
export const journalExportStatuses = [
  "PENDING",
  "WRITTEN",
  "STALE",
  "FAILED",
  "SUPERSEDED",
] as const;
export type JournalExportStatus = (typeof journalExportStatuses)[number];

/**
 * Enumerated note kinds the exporter knows how to generate. Each has
 * a deterministic filename template and a single author (the sweeper).
 */
export const journalNoteKinds = [
  "DAILY_SUMMARY", // one per account per day
  "WEEKLY_REVIEW", // one per account per ISO week
  "SETUP_CARD", // one per high-conviction setup
  "TRADE_NOTE", // one per closed position
  "RULE_VIOLATION", // one per RuleViolation
  "AI_LESSON", // one per active AiLesson
  "ACCOUNT_OVERVIEW", // one per account
  "NEWS_BRIEF", // one per significant news cluster
  "RUNBOOK", // operational notes (manually seeded, updated by exporter)
] as const;
export type JournalNoteKind = (typeof journalNoteKinds)[number];

/**
 * One journal export attempt / result. Idempotent per (kind, entityId,
 * bucket) — if the underlying entity changes we write a new version
 * with an updated `contentHash`.
 */
export const journalExportSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(journalNoteKinds),
  entityId: z.string(), // e.g. the AccountDailyMetric id, or Position id
  bucket: z.string(), // e.g. "2026-04-22" or "2026-W17"
  accountId: z.string().nullable(),
  relativePath: z.string(), // path inside vault, e.g. "accounts/funded-ftmo/2026-04-22.md"
  contentHash: z.string(),
  status: z.enum(journalExportStatuses),
  attempts: z.number().int().nonnegative().default(0),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  writtenAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JournalExportRecord = z.infer<typeof journalExportSchema>;

/**
 * Shape of a templated note — kept abstract so the writer in
 * packages/obsidian can render any kind the same way. A frontmatter
 * block + body.
 */
export const journalNoteSchema = z.object({
  kind: z.enum(journalNoteKinds),
  relativePath: z.string(),
  frontmatter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])),
  body: z.string(),
});
export type JournalNote = z.infer<typeof journalNoteSchema>;
