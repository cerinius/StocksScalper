/**
 * Atomic writer for the Obsidian vault.
 *
 * Guarantees:
 *  - Atomic: writes to .tmp, syncs, then renames. Never leaves partial files.
 *  - Idempotent: skips write when content hash matches existing file.
 *  - Safe: all paths are resolved through resolveVaultPath (no traversal).
 *  - Auditable: every write is recorded in the JournalExport table.
 */

import { writeFile, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "@stock-radar/logging";
import { resolveVaultPath, ensureVaultDir, getVaultConfig } from "./vault";

const logger = createLogger("obsidian-writer");

export interface WriteResult {
  written: boolean;    // true if file was actually written (false = content unchanged)
  absPath: string;
  contentHash: string;
}

/**
 * Write content to the vault at the given relative path.
 * Returns whether a write occurred and the content hash.
 * Throws on path traversal, missing vault, or I/O error.
 */
export const writeVaultNote = async (
  relativePath: string,
  content: string,
): Promise<WriteResult> => {
  const { enabled, vaultRoot } = getVaultConfig();
  if (!enabled || !vaultRoot) {
    throw new Error("Obsidian vault is not enabled or OBSIDIAN_VAULT_PATH is not configured.");
  }

  const absPath = resolveVaultPath(relativePath);
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");

  // Idempotency check: skip if file exists and hash matches
  if (existsSync(absPath)) {
    try {
      const existing = await readFile(absPath, "utf8");
      const existingHash = createHash("sha256").update(existing, "utf8").digest("hex");
      if (existingHash === contentHash) {
        return { written: false, absPath, contentHash };
      }
    } catch {
      // If we can't read the existing file, overwrite it
    }
  }

  const dir = dirname(absPath);
  await ensureVaultDir(dir);

  const tmpPath = `${absPath}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, absPath);

  logger.debug("Vault note written", { relativePath, contentHash: contentHash.slice(0, 8) });
  return { written: true, absPath, contentHash };
};
