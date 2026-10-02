import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { installations, repoMemories, plans, testCases, usage, type Database } from "@oxyqa/db";
import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { PROMPT_VERSION, type PromptInput, type PrJob, type GenerateResult } from "@oxyqa/core";
import { processPlan } from "../src/plans.js";

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
