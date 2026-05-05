import type {
  Account,
  AccountRuleProfile,
  AccountPhase,
  AccountSnapshotExtended,
} from "@stock-radar/types";

/**
 * Minimal in-memory lookup for the active account/phase/rule-profile
 * set used by the execution worker. The worker populates this from
 * the DB on each cycle (no caching across cycles — cheap read).
 *
 * This is purposely a plain interface; packages/db implements a
 * `loadAccountRegistry()` helper that returns an AccountRegistry.
 */
export interface AccountRegistryEntry {
  account: Account;
  activePhase: AccountPhase | null;
  activeRuleProfile: AccountRuleProfile | null;
  latestSnapshot: AccountSnapshotExtended | null;
}

export class AccountRegistry {
  private readonly byId = new Map<string, AccountRegistryEntry>();

  constructor(entries: AccountRegistryEntry[]) {
    for (const e of entries) {
      this.byId.set(e.account.id, e);
    }
  }

  get(accountId: string): AccountRegistryEntry | undefined {
    return this.byId.get(accountId);
  }

  list(): AccountRegistryEntry[] {
    return Array.from(this.byId.values());
  }

  listActive(): AccountRegistryEntry[] {
    return this.list().filter((e) => e.account.isActive);
  }

  listByKind(kind: Account["kind"]): AccountRegistryEntry[] {
    return this.list().filter((e) => e.account.kind === kind);
  }

  /**
   * Accounts that are *eligible* to place a new trade RIGHT NOW,
   * ignoring setup-specific fit. An account is eligible if:
   *   - account is active
   *   - it has an active rule profile + active phase
   *   - its mode permits opening (LOCKED excluded)
   *   - its latest snapshot is not breached
   */
  listEligibleForOpen(): AccountRegistryEntry[] {
    return this.listActive().filter((e) => {
      if (!e.activeRuleProfile || !e.activePhase) return false;
      if (e.account.mode === "LOCKED") return false;
      const snap = e.latestSnapshot;
      if (!snap) return true; // optimistic — engine will re-check with fresh snapshot
      if (snap.killSwitchActive) return false;
      if (snap.accountHealth === "BREACHED") return false;
      return true;
    });
  }
}
