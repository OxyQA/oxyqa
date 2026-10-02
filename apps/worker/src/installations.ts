import { installations, type Database } from "@oxyqa/db";
import { and, eq, isNull, lt } from "drizzle-orm";

/** The subset of GitHub's installation object this sync reads. */
export interface GitHubInstallation {
  account: { login?: string; slug?: string; type?: string } | null;
  suspended_at: string | null;
}

export type InstallationState = "active" | "suspended" | "deleted";

// Installation accounts are a user/org (login + type) or an enterprise (slug).
function describeAccount(account: GitHubInstallation["account"]) {
  if (account?.login) return { accountLogin: account.login, accountType: account.type ?? "Unknown" };
  if (account?.slug) return { accountLogin: account.slug, accountType: "Enterprise" };
  return { accountLogin: "unknown", accountType: "Unknown" };
}

/**
 * Mirrors GitHub's current view of an installation into `installations`.
 * State is re-read rather than taken from the event payload, so out-of-order
 * deliveries and retries converge on the truth. `fetch` returns null for 404.
 * Install-level `config` is never touched here.
 */
export async function syncInstallation(
  db: Database,
  installationId: number,
  fetch: (id: number) => Promise<GitHubInstallation | null>,
): Promise<InstallationState> {
  const data = await fetch(installationId);
  const now = new Date();
  if (!data) {
    await db.update(installations).set({ deletedAt: now, updatedAt: now })
      .where(and(eq(installations.id, installationId), isNull(installations.deletedAt)));
    return "deleted";
  }
  const values = {
    ...describeAccount(data.account),
    suspendedAt: data.suspended_at ? new Date(data.suspended_at) : null,
    deletedAt: null,
    updatedAt: now,
  };
  await db.insert(installations).values({ id: installationId, ...values })
    .onConflictDoUpdate({ target: installations.id, set: values });
  return values.suspendedAt ? "suspended" : "active";
}

/** Days an uninstalled installation's data is kept before it is purged (PRIVACY.md). */
export const UNINSTALL_RETENTION_DAYS = 30;

/**
 * Hard-deletes installations uninstalled more than the retention period ago.
 * Plans, test cases, memories, usage and feedback go with them (FK cascade).
 * Idempotent, so every worker replica may run it.
 */
export async function purgeUninstalled(db: Database, now = new Date(), retentionDays = UNINSTALL_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const rows = await db.delete(installations).where(lt(installations.deletedAt, cutoff)).returning({ id: installations.id });
  return rows.length;
}
