import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { installations, plans, testCases, type Database } from "@oxyqa/db";
import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import type { CommandJob } from "@oxyqa/core";
import { upsertTrackingIssue } from "../src/tracking-issue.js";

const job: CommandJob = { kind: "command", installationId: 1, owner: "org", repo: "repo", prNumber: 7, commentId: 3, actor: "alice", command: { type: "create-issue" } };

test("tracking issue: one per PR, created then updated, tenant-scoped, permission-aware", async (t) => {
  const client = new PGlite(); t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  await db.insert(installations).values([{ id: 1, accountLogin: "org", accountType: "Organization" }, { id: 2, accountLogin: "org", accountType: "Organization" }]);

  const issues = new Map<number, { title: string; body: string }>();
  let mode: "ok" | "forbidden" | "disabled" = "ok";
  const fail = () => { if (mode !== "ok") throw Object.assign(new Error("nope"), { status: mode === "forbidden" ? 403 : 410 }); };
  const octokit = {
    rest: {
      pulls: { get: async () => ({ data: { title: "Add lockout" } }) },
      repos: { getContent: async () => ({ data: { type: "file", content: Buffer.from("commentStyle: grouped").toString("base64") } }) },
      issues: {
        create: async ({ title, body }: { title: string; body: string }) => { fail(); const number = 100 + issues.size; issues.set(number, { title, body }); return { data: { number, html_url: `https://github.com/org/repo/issues/${number}` } }; },
        update: async ({ issue_number, title, body }: { issue_number: number; title: string; body: string }) => {
          fail();
          if (!issues.has(issue_number)) throw Object.assign(new Error("gone"), { status: 404 });
          issues.set(issue_number, { title, body }); return { data: { number: issue_number, html_url: `https://github.com/org/repo/issues/${issue_number}` } };
        },
      },
    },
  } as unknown as Octokit;
  const deps = { db: db as unknown as Database, octokit };
  const addPlan = async (headSha: string, status: string, installationId = 1, updatedAt = new Date()) => {
    const [row] = await db.insert(plans).values({ installationId, owner: "org", repo: "repo", prNumber: 7, headSha, status, summary: `Summary ${headSha[0]}`, updatedAt }).returning({ id: plans.id });
    await db.insert(testCases).values([
      { planId: row!.id, position: 1, title: `Low ${headSha[0]}`, steps: ["s"], priority: "low" },
      { planId: row!.id, position: 0, title: `Critical ${headSha[0]}`, steps: ["s"], priority: "critical" },
    ]);
    return row!.id;
  };

  assert.deepEqual(await upsertTrackingIssue(job, deps), { status: "no-plan" });
  await db.insert(plans).values({ installationId: 1, owner: "org", repo: "repo", prNumber: 7, headSha: "f".repeat(40), status: "failed" });
  await addPlan("e".repeat(40), "posted", 2);
  assert.deepEqual(await upsertTrackingIssue(job, deps), { status: "no-plan" }, "plans without cases and other tenants' plans are not used");

  const first = await addPlan("a".repeat(40), "posted", 1, new Date(Date.now() - 60_000));
  mode = "forbidden";
  assert.deepEqual(await upsertTrackingIssue(job, deps), { status: "no-permission" });
  mode = "disabled";
  assert.deepEqual(await upsertTrackingIssue(job, deps), { status: "issues-disabled" });
  mode = "ok";
  assert.equal(issues.size, 0);

  const created = await upsertTrackingIssue(job, deps);
  assert.deepEqual(created, { status: "created", number: 100, url: "https://github.com/org/repo/issues/100" });
  assert.equal(issues.get(100)!.title, "QA: Add lockout (#7)");
  assert.match(issues.get(100)!.body, /\*\*1\. Critical a\*\*[\s\S]*\*\*2\. Low a\*\*/);
  assert.equal((await db.select().from(plans).where(eq(plans.id, first)))[0]!.trackingIssueNumber, 100);

  await addPlan("b".repeat(40), "posted");
  const updated = await upsertTrackingIssue(job, deps);
  assert.equal(updated.status, "updated");
  assert.equal(issues.size, 1, "a new head updates the same issue instead of opening another");
  assert.match(issues.get(100)!.body, /Summary b[\s\S]*Critical b/);

  // Found live on staging: a plan that is regenerating (or whose last run
  // failed) still has its previous cases, and must not read as "no plan".
  await db.update(plans).set({ status: "processing", updatedAt: new Date(Date.now() + 1000) }).where(eq(plans.headSha, "b".repeat(40)));
  assert.equal((await upsertTrackingIssue(job, deps)).status, "updated", "usable while regenerating");
  await db.insert(plans).values({ installationId: 1, owner: "org", repo: "repo", prNumber: 7, headSha: "c".repeat(40), status: "failed", updatedAt: new Date(Date.now() + 2000) });
  assert.equal((await upsertTrackingIssue(job, deps)).status, "updated", "a newer failed run with no cases falls back to the last plan");
  assert.match(issues.get(100)!.body, /Critical b/);

  issues.clear();
  const reopened = await upsertTrackingIssue(job, deps);
  assert.equal(reopened.status, "created", "a deleted tracking issue is replaced");
  assert.equal(issues.size, 1);
});
