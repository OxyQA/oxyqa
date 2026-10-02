import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createWebhookApp } from "../src/app.js";
import type { OxyqaJob } from "@oxyqa/core";

const secret = "offline-test-secret";
const payload = {
  action: "created", installation: { id: 42 }, repository: { name: "repo", owner: { login: "org" } },
  issue: { number: 7, pull_request: {} },
  comment: { id: 99, body: "@oxyqa-staging remember: support Safari", user: { login: "alice", type: "User" } },
};
function request(event: string, value: unknown, valid = true, delivery?: string) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Request("http://localhost/webhooks/github", { method: "POST", body, headers: {
    "x-github-event": event,
    ...(delivery ? { "x-github-delivery": delivery } : {}),
    "x-hub-signature-256": `sha256=${createHmac("sha256", valid ? secret : "wrong").update(body).digest("hex")}`,
  } });
}
function fixture() {
  const jobs = new Map<string, OxyqaJob>();
  return { jobs, app: createWebhookApp({ secret, slug: "oxyqa-staging", ping: async () => "PONG", enqueue: async (job, id) => { if (!jobs.has(id)) jobs.set(id, job); } }) };
}

test("signed PR command queues with actor and deduplicates comment deliveries", async () => {
  const { app, jobs } = fixture();
  assert.equal((await app.request(request("issue_comment", payload))).status, 200);
  await app.request(request("issue_comment", payload));
  assert.equal(jobs.size, 1);
  assert.deepEqual([...jobs.values()][0], { kind: "command", installationId: 42, owner: "org", repo: "repo", prNumber: 7, commentId: 99, actor: "alice", command: { type: "remember", text: "support Safari" } });
});

test("signature and malformed payloads fail closed", async () => {
  const { app, jobs } = fixture();
  assert.equal((await app.request(request("issue_comment", payload, false))).status, 401);
  assert.equal((await app.request(request("issue_comment", "{"))).status, 400);
  assert.equal((await app.request(request("issue_comment", {}))).status, 400);
  assert.equal(jobs.size, 0);
});

test("bots, ordinary issues, edited comments and other app mentions are ignored", async () => {
  const { app, jobs } = fixture();
  for (const p of [
    { ...payload, action: "edited" }, { ...payload, issue: { number: 7 } },
    { ...payload, comment: { ...payload.comment, user: { login: "bot", type: "Bot" } } },
    { ...payload, comment: { ...payload.comment, body: "@oxyqa remember: wrong environment" } },
  ]) assert.equal((await app.request(request("issue_comment", p))).status, 200);
  assert.equal(jobs.size, 0);
});

test("PR deliveries keep automatic generation and isolate identical SHAs on different PRs", async () => {
  const { app, jobs } = fixture();
  const p = { ...payload, action: "opened", pull_request: { number: 1, head: { sha: "a".repeat(40) } } };
  await app.request(request("pull_request", p));
  await app.request(request("pull_request", p));
  await app.request(request("pull_request", { ...p, pull_request: { ...p.pull_request, number: 2 } }));
  await app.request(request("pull_request", { ...p, pull_request: { ...p.pull_request, number: 3, draft: true } }));
  assert.equal(jobs.size, 2);
});

test("enqueue failure is retryable instead of consuming the event", async () => {
  let attempts = 0;
  const reported: unknown[] = [];
  const app = createWebhookApp({
    secret, slug: "oxyqa-staging", ping: async () => {},
    enqueue: async () => { if (++attempts === 1) throw new Error("offline queue failure"); },
    reportError: (err, context) => reported.push([(err as Error).message, context.event]),
  });
  const failed = await app.request(request("issue_comment", payload));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "internal error" }, "error detail stays out of the response");
  assert.deepEqual(reported, [["offline queue failure", "issue_comment"]]);
  assert.equal((await app.request(request("issue_comment", payload))).status, 200);
});

test("install lifecycle events queue one job per delivery, without a repository", async () => {
  const { app, jobs } = fixture();
  const install = { action: "suspend", installation: { id: 42 } };
  assert.equal((await app.request(request("installation", install, true, "d-1"))).status, 200);
  await app.request(request("installation", install, true, "d-1"));
  await app.request(request("installation", { ...install, action: "unsuspend" }, true, "d-2"));
  await app.request(request("installation_repositories", { ...install, action: "added" }, true, "d-3"));
  assert.deepEqual([...jobs.values()].map((j) => j.kind === "installation" && j.action), [
    "installation.suspend", "installation.unsuspend", "installation_repositories.added",
  ]);
  assert.equal((await app.request(request("installation", { action: "deleted" }, true, "d-4"))).status, 400);
  assert.equal((await app.request(request("installation", install, false, "d-5"))).status, 401);
  assert.equal(jobs.size, 3);
});

test("closing a PR queues feedback collection per delivery and never a plan", async () => {
  const { app, jobs } = fixture();
  const closed = { ...payload, action: "closed", pull_request: { number: 5, head: { sha: "a".repeat(40) } } };
  await app.request(request("pull_request", closed, true, "c-1"));
  await app.request(request("pull_request", closed, true, "c-1"));
  await app.request(request("pull_request", closed, true, "c-2"));
  assert.deepEqual([...jobs.values()], Array(2).fill({ kind: "feedback", installationId: 42, owner: "org", repo: "repo", prNumber: 5 }));
});
