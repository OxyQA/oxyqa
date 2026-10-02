import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { installations, repoMemories, plans, testCases, usage, type Database } from "@oxyqa/db";
import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { PROMPT_VERSION, type PromptInput, type PrJob, type GenerateResult } from "@oxyqa/core";
import { processPlan, reportPlanFailure } from "../src/plans.js";

const job: PrJob = { installationId: 1, owner: "org", repo: "repo", prNumber: 7, headSha: "a".repeat(40), action: "command" };
const result: GenerateResult = {
  promptVersion: PROMPT_VERSION,
  plan: { summary: "Login change", testCases: [{ title: "Keyboard login", description: "Tab through login", priority: "high", steps: ["Press Tab"], expected: "Focus moves to login" }] },
  usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
};

test("full plan pipeline runs against local PostgreSQL and a stubbed model/GitHub", async (t) => {
  const client = new PGlite(); t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  await db.insert(installations).values({ id: 1, accountLogin: "org", accountType: "Organization" });
  await db.insert(repoMemories).values([
    { installationId: 1, owner: "org", repo: "repo", content: "Always test Safari", createdBy: "alice" },
    { installationId: 1, owner: "org", repo: "other", content: "Other repo guidance", createdBy: "alice" },
  ]);
  let currentSha = job.headSha;
  const inputs: PromptInput[] = [];
  const comments: { id: number; number: number; body: string; user: { login: string } }[] = [];
  const paginate = Object.assign(async () => [{ filename: "login.ts", status: "modified", additions: 1, deletions: 0, patch: "+ keyboard login" }], {
    async *iterator(_: unknown, args: { issue_number: number }) { yield { data: comments.filter((c) => c.number === args.issue_number) }; },
  });
  const octokit = {
    paginate,
    rest: {
      pulls: { get: async () => ({ data: { title: "Login", body: "A change", state: "open", draft: false, head: { sha: currentSha } } }), listFiles() {} },
      repos: {
        getContent: async ({ path }: { path: string }) => ({ data: { type: "file", content: Buffer.from(path.endsWith("config.yml") ? "maxCases: 8\ncommentStyle: grouped" : "A web app").toString("base64") } }),
      },
      issues: {
        listComments() {},
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => { const comment = { id: comments.length + 1, number: issue_number, body, user: { login: "oxyqa-staging[bot]" } }; comments.push(comment); return { data: comment }; },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => { comments.find((c) => c.id === comment_id)!.body = body; },
      },
    },
  } as unknown as Octokit;
  const deps = { db: db as unknown as Database, octokit, slug: "oxyqa-staging", model: "offline-stub", generate: async (input: PromptInput) => { inputs.push(input); return result; } };

  await processPlan({ ...job, oneShotFocus: "accessibility" }, deps);
  assert.equal(inputs[0]!.repoMemories, "- Always test Safari");
  assert.equal(inputs[0]!.oneShotFocus, "accessibility");
  assert.equal(inputs[0]!.repoContext, "A web app");
  assert.equal(inputs[0]!.behavior!.maxCases, 8);
  assert.match(comments[0]!.body, /### 🟠 high/);
  assert.equal((await db.select().from(plans))[0]!.status, "posted");

  await processPlan(job, deps);
  assert.equal(comments.length, 1, "regeneration updates the bot's comment");
  assert.equal((await db.select().from(plans)).length, 1);
  assert.equal((await db.select().from(testCases)).length, 1, "regeneration replaces cases");
  assert.equal((await db.select().from(usage)).length, 2, "both model runs are metered");
  assert.equal(inputs[1]!.oneShotFocus, undefined);

  await processPlan({ ...job, prNumber: 8 }, deps);
  assert.equal((await db.select().from(plans)).length, 2, "same head SHA on different PRs has separate plans");
  assert.equal(comments.length, 2);

  currentSha = "b".repeat(40);
  assert.deepEqual(await processPlan(job, deps), { skipped: "stale or closed PR" });
  assert.equal(inputs.length, 3, "stale queued work never calls model");
  currentSha = job.headSha;
  await processPlan(job, { ...deps, generate: async (input) => { inputs.push(input); currentSha = "c".repeat(40); return result; } });
  assert.equal((await db.select().from(plans).where(eq(plans.prNumber, 7)))[0]!.status, "superseded");
  assert.equal(comments.length, 2, "head changes during generation do not publish an outdated plan");
  assert.equal((await db.select().from(usage)).length, 4, "superseded generation is still metered");
});

test("final failure marks the plan failed and banners the comment without losing a previous plan", async (t) => {
  const client = new PGlite(); t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  await db.insert(installations).values({ id: 1, accountLogin: "org", accountType: "Organization" });
  let currentSha = job.headSha;
  let state = "open";
  const comments: { id: number; number: number; body: string; user: { login: string } }[] = [];
  const paginate = Object.assign(async () => [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "+a" }], {
    async *iterator(_: unknown, args: { issue_number: number }) { yield { data: comments.filter((c) => c.number === args.issue_number) }; },
  });
  const octokit = {
    paginate,
    rest: {
      pulls: { get: async () => ({ data: { title: "T", body: "", state, draft: false, head: { sha: currentSha } } }), listFiles() {} },
      repos: { getContent: async () => { throw Object.assign(new Error("nf"), { status: 404 }); }, getReadme: async () => { throw Object.assign(new Error("nf"), { status: 404 }); } },
      issues: {
        listComments() {},
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => { const c = { id: comments.length + 1, number: issue_number, body, user: { login: "oxyqa-staging[bot]" } }; comments.push(c); return { data: c }; },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => { comments.find((c) => c.id === comment_id)!.body = body; },
      },
    },
  } as unknown as Octokit;
  const deps = { db: db as unknown as Database, octokit, slug: "oxyqa-staging" };
  const planDeps = { ...deps, model: "offline-stub", generate: async () => result };
  const modelDown = Object.assign(new Error("Overloaded at https://internal"), { name: "AI_APICallError", statusCode: 529 });
  const failingRun = async (j: PrJob = job) => {
    const attemptStartedAt = new Date();
    await assert.rejects(processPlan(j, { ...planDeps, generate: async () => { throw modelDown; } }));
    return reportPlanFailure(j, modelDown, { ...deps, attemptStartedAt });
  };
  const status = async (prNumber = 7) => (await db.select().from(plans).where(eq(plans.prNumber, prNumber)))[0]!.status;

  await t.test("first-ever run fails: standalone banner, plan failed, no raw error text", async () => {
    const r = await failingRun();
    assert.equal((r as { failed: string }).failed, "the model provider was overloaded or unavailable");
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /\[!WARNING\][\s\S]*`@oxyqa-staging regenerate` to retry/);
    assert.doesNotMatch(comments[0]!.body, /internal/);
    assert.equal(await status(), "failed");
  });
  await t.test("success after failure replaces the banner with the plan", async () => {
    await processPlan(job, planDeps);
    assert.equal(comments.length, 1);
    assert.doesNotMatch(comments[0]!.body, /WARNING/);
    assert.equal(await status(), "posted");
  });
  await t.test("failed regenerate keeps the previous plan under the banner", async () => {
    await failingRun();
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /WARNING[\s\S]*earlier run[\s\S]*Keyboard login/);
    assert.equal(await status(), "failed");
  });
  await t.test("a run that succeeded after the failing attempt started wins", async () => {
    const attemptStartedAt = new Date(Date.now() - 60_000);
    await processPlan(job, planDeps);
    assert.deepEqual(await reportPlanFailure(job, modelDown, { ...deps, attemptStartedAt }), { skipped: "a later run succeeded" });
    assert.doesNotMatch(comments[0]!.body, /WARNING/);
    assert.equal(await status(), "posted");
  });
  await t.test("stale or closed PRs stay quiet", async () => {
    currentSha = "d".repeat(40);
    assert.deepEqual(await reportPlanFailure(job, modelDown, { ...deps, attemptStartedAt: new Date() }), { skipped: "stale or closed PR" });
    currentSha = job.headSha; state = "closed";
    assert.deepEqual(await reportPlanFailure(job, modelDown, { ...deps, attemptStartedAt: new Date() }), { skipped: "stale or closed PR" });
    assert.doesNotMatch(comments[0]!.body, /WARNING/);
  });
});

test("monthly cap blocks generation before any model call and resets with the calendar month", async (t) => {
  const client = new PGlite(); t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  await db.insert(installations).values([
    { id: 1, accountLogin: "org", accountType: "Organization", config: { monthlyPlanLimit: 2 } },
    { id: 2, accountLogin: "other", accountType: "Organization", config: { monthlyPlanLimit: 2 } },
  ]);
  // Last month's usage and another tenant's usage must not count.
  await db.insert(usage).values([
    { installationId: 1, repo: "repo", prNumber: 1, model: "m", createdAt: new Date(Date.now() - 40 * 86_400_000) },
    { installationId: 2, repo: "repo", prNumber: 1, model: "m" },
    { installationId: 2, repo: "repo", prNumber: 1, model: "m" },
  ]);
  const comments: { id: number; number: number; body: string; user: { login: string } }[] = [];
  const paginate = Object.assign(async () => [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "+a" }], {
    async *iterator(_: unknown, args: { issue_number: number }) { yield { data: comments.filter((c) => c.number === args.issue_number) }; },
  });
  const notFound = async () => { throw Object.assign(new Error("nf"), { status: 404 }); };
  const octokit = {
    paginate,
    rest: {
      pulls: { get: async () => ({ data: { title: "T", body: "", state: "open", draft: false, head: { sha: job.headSha } } }), listFiles() {} },
      repos: { getContent: notFound, getReadme: notFound },
      issues: {
        listComments() {},
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => { const c = { id: comments.length + 1, number: issue_number, body, user: { login: "oxyqa-staging[bot]" } }; comments.push(c); return { data: c }; },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => { comments.find((c) => c.id === comment_id)!.body = body; },
      },
    },
  } as unknown as Octokit;
  let calls = 0;
  const deps = { db: db as unknown as Database, octokit, slug: "oxyqa-staging", model: "offline-stub", generate: async () => { calls++; return result; } };

  await processPlan(job, deps);
  await processPlan({ ...job, prNumber: 8 }, deps);
  assert.equal(calls, 2);
  const limited = await processPlan(job, deps);
  assert.equal((limited as { skipped: string }).skipped, "monthly plan limit reached");
  assert.equal(calls, 2, "no model call once the cap is reached");
  assert.match(comments[0]!.body, /\[!NOTE\][\s\S]*limit of 2 test plans per month[\s\S]*earlier run[\s\S]*Keyboard login/);
  assert.equal((await db.select().from(plans).where(eq(plans.prNumber, 7)))[0]!.status, "limited");
  assert.equal((await db.select().from(usage).where(eq(usage.installationId, 1))).length, 3, "skipped runs are not metered");

  await processPlan({ ...job, prNumber: 9 }, deps);
  assert.match(comments[2]!.body, /\[!NOTE\]/, "a PR with no plan yet gets a standalone notice");
  assert.doesNotMatch(comments[2]!.body, /earlier run/);

  await processPlan(job, { ...deps, mode: "self-hosted" });
  assert.equal(calls, 3, "self-hosted deployments are never capped");
  const nextMonth = new Date(); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 2);
  await processPlan(job, { ...deps, now: () => nextMonth });
  assert.equal(calls, 4, "the cap resets with the UTC month");
  assert.doesNotMatch(comments[0]!.body, /\[!NOTE\]/);
});
