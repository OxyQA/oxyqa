import { renderTrackingIssue, type CommandJob } from "@oxyqa/core";
import { plans, type Database } from "@oxyqa/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Octokit } from "octokit";
import { loadLatestPlan, plansForPr } from "./latest-plan.js";

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
  const { owner, repo, prNumber } = job;
  const latest = await loadLatestPlan(job, { db, octokit });
  if (!latest) return { status: "no-plan" };
  const { plan, cases, style } = latest;
  const forPr = plansForPr(job);

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const issue = renderTrackingIssue({ prNumber, prTitle: pr.title, headSha: plan.headSha, summary: plan.summary, style, cases });

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
