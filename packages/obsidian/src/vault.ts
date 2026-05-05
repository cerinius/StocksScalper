/**
 * Vault — path resolution and safety for the Obsidian vault.
 *
 * The vault root is read from OBSIDIAN_VAULT_PATH. All writes are scoped
 * under <vault>/StocksScalper/ to keep user-authored notes separate.
 * Path traversal is actively prevented.
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

export const STOCK_RADAR_SUBDIR = "StocksScalper";

export const getVaultConfig = (): {
  enabled: boolean;
  vaultRoot: string;
  stockRadarRoot: string;
} => {
  const enabled = process.env.OBSIDIAN_ENABLED === "true";
  const vaultRoot = (process.env.OBSIDIAN_VAULT_PATH ?? "").trim();
  const stockRadarRoot = vaultRoot ? resolve(join(vaultRoot, STOCK_RADAR_SUBDIR)) : "";

  return { enabled, vaultRoot, stockRadarRoot };
};

/**
 * Resolve a relative path within the StocksScalper vault subdirectory.
 * Throws if the resolved path would escape the vault root (path traversal prevention).
 */
export const resolveVaultPath = (relativePath: string): string => {
  const { stockRadarRoot, vaultRoot } = getVaultConfig();
  if (!vaultRoot) throw new Error("OBSIDIAN_VAULT_PATH is not configured.");

  const normalized = relativePath.replace(/\\/g, "/").replace(/\.\.+/g, ".");
  const resolved = resolve(join(stockRadarRoot, normalized));

  if (!resolved.startsWith(stockRadarRoot + "/") && resolved !== stockRadarRoot) {
    throw new Error(
      `Path traversal detected: "${relativePath}" would resolve outside vault.`,
    );
  }

  return resolved;
};

/**
 * Ensure the vault's StocksScalper root and a given directory exist.
 */
export const ensureVaultDir = async (absDir: string): Promise<void> => {
  await mkdir(absDir, { recursive: true });
};

/**
 * Validate that the vault root directory exists and is accessible.
 * Call this on startup to surface mis-configuration early.
 */
export const validateVault = (): { ok: boolean; reason?: string } => {
  const { enabled, vaultRoot } = getVaultConfig();
  if (!enabled) return { ok: true }; // Disabled is not an error
  if (!vaultRoot) return { ok: false, reason: "OBSIDIAN_VAULT_PATH is not set." };
  if (!existsSync(vaultRoot)) return { ok: false, reason: `Vault root does not exist: ${vaultRoot}` };
  return { ok: true };
};
