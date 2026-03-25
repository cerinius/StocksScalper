-- Migration: add @unique to Notification.dedupeKey
-- Safe deduplication: keep the most recent row per dedupeKey before adding the constraint

DELETE FROM "Notification"
WHERE id NOT IN (
  SELECT DISTINCT ON ("dedupeKey") id
  FROM "Notification"
  ORDER BY "dedupeKey", "createdAt" DESC
);

-- Drop the old non-unique index if it exists
DROP INDEX IF EXISTS "Notification_dedupeKey_idx";

-- Create the unique constraint
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
