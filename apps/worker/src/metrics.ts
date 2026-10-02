import { feedback, installations, plans, repoMemories, usage, type Database } from "@oxyqa/db";
import { and, count, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";

export interface Metrics {
  since: Date;
  installs: { active: number; suspended: number; uninstalled: number };
  /** Installations with at least one model run in the window. */
  activeInstalls: number;
  plans: Record<string, number>;
  modelRuns: number;
  /** Model runs per posted plan; above 1 means people regenerate. */
  runsPerPostedPlan: number | null;
  tokens: { input: number; output: number };
  feedback: { up: number; down: number; plansWithFeedback: number };
  memories: number;
  trackingIssues: number;
}

/** Product health straight from the database — no analytics service needed. */
export async function collectMetrics(db: Database, since: Date): Promise<Metrics> {
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const installs = {
    active: await n(db.select({ n: count() }).from(installations).where(and(isNull(installations.deletedAt), isNull(installations.suspendedAt)))),
    suspended: await n(db.select({ n: count() }).from(installations).where(and(isNull(installations.deletedAt), isNotNull(installations.suspendedAt)))),
    uninstalled: await n(db.select({ n: count() }).from(installations).where(isNotNull(installations.deletedAt))),
  };
  const byStatus = await db.select({ status: plans.status, n: count() }).from(plans).where(gte(plans.updatedAt, since)).groupBy(plans.status);
  const [u] = await db.select({
    runs: count(), input: sql<number>`coalesce(sum(${usage.inputTokens}), 0)::int`, output: sql<number>`coalesce(sum(${usage.outputTokens}), 0)::int`,
    installs: sql<number>`count(distinct ${usage.installationId})::int`,
  }).from(usage).where(gte(usage.createdAt, since));
  const [f] = await db.select({
    up: sql<number>`count(*) filter (where ${feedback.reaction} = '+1')::int`,
    down: sql<number>`count(*) filter (where ${feedback.reaction} = '-1')::int`,
    plans: sql<number>`count(distinct ${feedback.planId})::int`,
  }).from(feedback).where(gte(feedback.createdAt, since));
  const plansByStatus = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const posted = plansByStatus.posted ?? 0;
  return {
    since, installs, activeInstalls: u?.installs ?? 0, plans: plansByStatus,
    modelRuns: u?.runs ?? 0, runsPerPostedPlan: posted ? Math.round(((u?.runs ?? 0) / posted) * 100) / 100 : null,
    tokens: { input: u?.input ?? 0, output: u?.output ?? 0 },
    feedback: { up: f?.up ?? 0, down: f?.down ?? 0, plansWithFeedback: f?.plans ?? 0 },
    memories: await n(db.select({ n: count() }).from(repoMemories).where(eq(repoMemories.active, true))),
    trackingIssues: await n(db.select({ n: count() }).from(plans).where(and(isNotNull(plans.trackingIssueNumber), gte(plans.updatedAt, since)))),
  };
}
