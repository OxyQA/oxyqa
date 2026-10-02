import type { FeedbackJob } from "@oxyqa/core";
import { feedback, plans, type Database } from "@oxyqa/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Octokit } from "octokit";

/**
 * Snapshots 👍/👎 reactions on a PR's plan comment into `feedback` — the core
 * quality signal (README: edit-rate/retention). GitHub sends no webhook for
 * reactions, so this runs when the PR closes and replaces the plan's rows:
 * re-collection after a reopen converges instead of double-counting.
 */
export async function collectFeedback(job: FeedbackJob, { db, octokit }: { db: Database; octokit: Octokit }) {
  const { installationId, owner, repo, prNumber } = job;
  const [plan] = await db.select({ id: plans.id, commentId: plans.commentId }).from(plans)
    .where(and(eq(plans.installationId, installationId), eq(plans.owner, owner), eq(plans.repo, repo),
      eq(plans.prNumber, prNumber), isNotNull(plans.commentId)))
    .orderBy(desc(plans.updatedAt)).limit(1);
  if (!plan?.commentId) return { skipped: "no plan comment" };

  let reactions: { content: string; user: { id: number; type?: string } | null }[];
  try {
    reactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, { owner, repo, comment_id: plan.commentId, per_page: 100 });
  } catch (err) {
    // The comment (or repo access) is gone — nothing to collect.
    if ([403, 404, 410].includes((err as { status?: number }).status ?? 0)) return { skipped: "comment unavailable" };
    throw err;
  }
  const votes = reactions
    .filter((r) => (r.content === "+1" || r.content === "-1") && r.user && r.user.type !== "Bot")
    .map((r) => ({ installationId, planId: plan.id, reaction: r.content, githubUserId: r.user!.id }));

  await db.transaction(async (tx) => {
    await tx.delete(feedback).where(eq(feedback.planId, plan.id));
    if (votes.length) await tx.insert(feedback).values(votes);
  });
  return { up: votes.filter((v) => v.reaction === "+1").length, down: votes.filter((v) => v.reaction === "-1").length };
}
