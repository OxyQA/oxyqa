import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { feedback, installations, plans, repoMemories, usage, type Database } from "@oxyqa/db";
import type { Octokit } from "octokit";
import type { FeedbackJob } from "@oxyqa/core";
import { collectFeedback } from "../src/feedback.js";
import { collectMetrics } from "../src/metrics.js";

const job: FeedbackJob = { kind: "feedback", installationId: 1, owner: "org", repo: "repo", prNumber: 7 };

test("feedback snapshots human 👍/👎 on the latest plan comment and metrics summarize the database", async (t) => {
  const client = new PGlite(); t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  await db.insert(installations).values([
    { id: 1, accountLogin: "org", accountType: "Organization" },
    { id: 2, accountLogin: "gone", accountType: "User", deletedAt: new Date() },
    { id: 3, accountLogin: "paused", accountType: "User", suspendedAt: new Date() },
  ]);
  let reactions: unknown[] = [];
  let status = 200;
  const asked: number[] = [];
  const octokit = {
    paginate: async (_: unknown, args: { comment_id: number }) => { asked.push(args.comment_id); if (status !== 200) throw Object.assign(new Error("x"), { status }); return reactions; },
    rest: { reactions: { listForIssueComment() {} } },
  } as unknown as Octokit;
  const deps = { db: db as unknown as Database, octokit };

  assert.deepEqual(await collectFeedback(job, deps), { skipped: "no plan comment" });
  await db.insert(plans).values([
    { installationId: 1, owner: "org", repo: "repo", prNumber: 7, headSha: "a".repeat(40), status: "posted", commentId: 11, updatedAt: new Date(Date.now() - 60_000) },
    { installationId: 1, owner: "org", repo: "repo", prNumber: 7, headSha: "b".repeat(40), status: "posted", commentId: 22, trackingIssueNumber: 5 },
    { installationId: 1, owner: "org", repo: "repo", prNumber: 8, headSha: "c".repeat(40), status: "failed" },
  ]);
  reactions = [
    { content: "+1", user: { id: 1, type: "User" } }, { content: "+1", user: { id: 2, type: "User" } },
    { content: "-1", user: { id: 3, type: "User" } }, { content: "heart", user: { id: 4, type: "User" } },
    { content: "+1", user: { id: 9, type: "Bot" } }, { content: "+1", user: null },
  ];
  assert.deepEqual(await collectFeedback(job, deps), { up: 2, down: 1 });
  assert.equal(asked.at(-1), 22, "reads the latest plan's comment");
  reactions = reactions.slice(0, 1);
  assert.deepEqual(await collectFeedback(job, deps), { up: 1, down: 0 }, "re-collection replaces, never double-counts");
  assert.equal((await db.select().from(feedback)).length, 1);
  status = 404;
  assert.deepEqual(await collectFeedback(job, deps), { skipped: "comment unavailable" });
  assert.equal((await db.select().from(feedback)).length, 1, "an unavailable comment keeps the last snapshot");

  await db.insert(usage).values([
    { installationId: 1, repo: "repo", prNumber: 7, model: "m", inputTokens: 1000, outputTokens: 200 },
    { installationId: 1, repo: "repo", prNumber: 7, model: "m", inputTokens: 500, outputTokens: 100 },
    { installationId: 1, repo: "repo", prNumber: 7, model: "m", inputTokens: 9, outputTokens: 9, createdAt: new Date(Date.now() - 90 * 86_400_000) },
  ]);
  await db.insert(repoMemories).values([
    { installationId: 1, owner: "org", repo: "repo", content: "a", createdBy: "x" },
    { installationId: 1, owner: "org", repo: "repo", content: "b", createdBy: "x", active: false },
  ]);
  const m = await collectMetrics(db as unknown as Database, new Date(Date.now() - 30 * 86_400_000));
  assert.deepEqual(m.installs, { active: 1, suspended: 1, uninstalled: 1 });
  assert.deepEqual(m.plans, { posted: 2, failed: 1 });
  assert.equal(m.modelRuns, 2);
  assert.equal(m.runsPerPostedPlan, 1);
  assert.deepEqual(m.tokens, { input: 1500, output: 300 });
  assert.deepEqual(m.feedback, { up: 1, down: 0, plansWithFeedback: 1 });
  assert.equal(m.activeInstalls, 1);
  assert.equal(m.memories, 1);
  assert.equal(m.trackingIssues, 1);
});
