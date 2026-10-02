import { REPO_CONFIG_PATH, renderTrackingIssue, resolveRepoConfig, type CommandJob } from "@oxyqa/core";
import { installations, plans, testCases, type Database } from "@oxyqa/db";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { Octokit } from "octokit";

export type TrackingIssueResult =
  | { status: "created" | "updated"; number: number; url: string }
  | { status: "no-plan" | "no-permission" | "issues-disabled" };

/**
 * Opens — or updates — the single tracking issue for a PR's latest posted
 * plan (DECISIONS.md §6: one issue per PR, never one per case). Needs the
 * App's Issues: write permission; without it the caller gets "no-permission"
 * rather than a failed job.
 */
export async function upsertTrackingIssue(job: CommandJob, { db, octokit }: { db: Database; octokit: Octokit }): Promise<TrackingIssueResult> {
  const { installationId, owner, repo, prNumber } = job;
  const forPr = and(eq(plans.installationId, installationId), eq(plans.owner, owner), eq(plans.repo, repo), eq(plans.prNumber, prNumber));
  const [plan] = await db.select().from(plans).where(and(forPr, eq(plans.status, "posted"))).orderBy(desc(plans.updatedAt)).limit(1);
  if (!plan) return { status: "no-plan" };
  const cases = await db.select().from(testCases).where(eq(testCases.planId, plan.id)).orderBy(asc(testCases.position), asc(testCases.createdAt));
  if (!cases.length) return { status: "no-plan" };

  // Number cases exactly as the PR comment does: same config, same head.
  const [install] = await db.select({ config: installations.config }).from(installations).where(eq(installations.id, installationId));
  let repoYaml: string | null = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: REPO_CONFIG_PATH, ref: plan.headSha });
    if (!Array.isArray(data) && data.type === "file") repoYaml = Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) { if ((err as { status?: number }).status !== 404) throw err; }
  const { config } = resolveRepoConfig({ repoYaml, installOverrides: install?.config });

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const issue = renderTrackingIssue({
    prNumber, prTitle: pr.title, headSha: plan.headSha, summary: plan.summary, style: config.commentStyle,
    cases: cases.map((c) => ({ title: c.title, description: c.description, steps: c.steps, expected: c.expected, priority: c.priority ?? "medium" })),
  });

  const [tracked] = await db.select({ number: plans.trackingIssueNumber }).from(plans)
    .where(and(forPr, isNotNull(plans.trackingIssueNumber))).orderBy(desc(plans.updatedAt)).limit(1);
  try {
    let result: { number: number; html_url: string } | undefined;
    let status: "created" | "updated" = "updated";
    if (tracked?.number) {
      try { ({ data: result } = await octokit.rest.issues.update({ owner, repo, issue_number: tracked.number, ...issue })); }
      // The tracked issue was deleted or transferred — fall through and open a new one.
      catch (err) { if (![404, 410].includes((err as { status?: number }).status ?? 0)) throw err; }
    }
    if (!result) {
      ({ data: result } = await octokit.rest.issues.create({ owner, repo, ...issue }));
      status = "created";
    }
    await db.update(plans).set({ trackingIssueNumber: result.number }).where(eq(plans.id, plan.id));
    return { status, number: result.number, url: result.html_url };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) return { status: "no-permission" };
    if (status === 410) return { status: "issues-disabled" };
    throw err;
  }
}
