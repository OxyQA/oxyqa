import { REPO_CONFIG_PATH, resolveRepoConfig, type CommandJob, type CommentStyle } from "@oxyqa/core";
import { installations, plans, testCases, type Database } from "@oxyqa/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Octokit } from "octokit";

export interface LatestPlanCase {
  title: string;
  description: string | null;
  steps: string[];
  expected: string | null;
  priority: string;
}

/** Tenant-scoped filter for every plan row of one pull request. */
export function plansForPr({ installationId, owner, repo, prNumber }: Pick<CommandJob, "installationId" | "owner" | "repo" | "prNumber">) {
  return and(eq(plans.installationId, installationId), eq(plans.owner, owner), eq(plans.repo, repo), eq(plans.prNumber, prNumber));
}

/**
 * The PR's most recent plan that has test cases, with those cases in generated
 * order and the comment layout in force at that commit — so callers can
 * number cases exactly as the PR comment does (numberCases). Null when the PR
 * has never had a plan.
 *
 * Status is deliberately not filtered: while a plan is regenerating
 * ("processing"), or after a failed or limited run, the previous cases are
 * still stored and still what the PR comment shows. Cases are only replaced
 * atomically when a new plan is posted.
 */
export async function loadLatestPlan(job: CommandJob, { db, octokit }: { db: Database; octokit: Octokit }) {
  const { installationId, owner, repo } = job;
  const candidates = await db.select().from(plans).where(plansForPr(job)).orderBy(desc(plans.updatedAt)).limit(5);
  let plan: (typeof candidates)[number] | undefined;
  let rows: (typeof testCases.$inferSelect)[] = [];
  for (const candidate of candidates) {
    rows = await db.select().from(testCases).where(eq(testCases.planId, candidate.id)).orderBy(asc(testCases.position), asc(testCases.createdAt));
    if (rows.length) { plan = candidate; break; }
  }
  if (!plan) return null;

  const [install] = await db.select({ config: installations.config }).from(installations).where(eq(installations.id, installationId));
  let repoYaml: string | null = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: REPO_CONFIG_PATH, ref: plan.headSha });
    if (!Array.isArray(data) && data.type === "file") repoYaml = Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) { if ((err as { status?: number }).status !== 404) throw err; }
  const style: CommentStyle = resolveRepoConfig({ repoYaml, installOverrides: install?.config }).config.commentStyle;
  const cases: LatestPlanCase[] = rows.map((c) => ({ title: c.title, description: c.description, steps: c.steps, expected: c.expected, priority: c.priority ?? "medium" }));
  return { plan, cases, style };
}
