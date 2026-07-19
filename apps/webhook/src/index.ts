// @oxyqa/webhook — ingress service.
//
// Fast path only (GitHub times out at ~10s): verify signature → dedup by head
// SHA → enqueue → return 200. All real work happens in @oxyqa/worker.
import { serve } from "@hono/node-server";
import { verify } from "@octokit/webhooks-methods";
import { createPrQueue, createRedisConnection, getConfig, type PrJob } from "@oxyqa/core";
import { Hono } from "hono";

const config = getConfig();
const redis = createRedisConnection(config.redisUrl);
const queue = createPrQueue(redis);

// The PR actions worth generating a plan for. Skip label/assignee/etc noise.
const HANDLED_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

// Minimal shape of the fields we read off a pull_request event payload.
interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: { number: number; head: { sha: string }; draft?: boolean };
}

const app = new Hono();

app.get("/", (c) => c.json({ service: "oxyqa-webhook", ok: true }));

// Railway healthcheck target. Reports Redis reachability without failing hard:
// a webhook that can't enqueue is degraded, and the deploy should know.
app.get("/health", async (c) => {
  try {
    await redis.ping();
    return c.json({ ok: true, redis: "up" });
  } catch {
    return c.json({ ok: false, redis: "down" }, 503);
  }
});

app.post("/webhooks/github", async (c) => {
  const signature = c.req.header("x-hub-signature-256");
  const eventName = c.req.header("x-github-event");
  const raw = await c.req.text();

  if (!signature || !(await verify(config.github.webhookSecret, raw, signature))) {
    return c.json({ error: "invalid signature" }, 401);
  }

  // Only pull_request events produce plans; ack everything else so GitHub is happy.
  if (eventName !== "pull_request") {
    return c.json({ ok: true, ignored: eventName }, 200);
  }

  const payload = JSON.parse(raw) as PullRequestEvent;
  if (!HANDLED_ACTIONS.has(payload.action) || payload.pull_request.draft) {
    return c.json({ ok: true, skipped: payload.action }, 200);
  }
  if (!payload.installation?.id) {
    return c.json({ error: "missing installation" }, 400);
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const headSha = payload.pull_request.head.sha;

  // Idempotency: first event for a given head SHA wins; GitHub re-fires are dropped.
  const dedupKey = `oxyqa:seen:${owner}/${repo}:${headSha}`;
  const isFirst = await redis.set(dedupKey, "1", "EX", 3600, "NX");
  if (isFirst !== "OK") {
    return c.json({ ok: true, duplicate: headSha }, 200);
  }

  const job: PrJob = {
    installationId: payload.installation.id,
    owner,
    repo,
    prNumber: payload.pull_request.number,
    headSha,
    action: payload.action,
  };
  // Job id = head SHA so BullMQ also dedups at the queue level.
  await queue.add("process-pr", job, { jobId: headSha });

  return c.json({ ok: true, queued: job.prNumber }, 200);
});

const server = serve({ fetch: app.fetch, port: config.webhookPort }, (info) => {
  console.log(`[oxyqa-webhook] listening on :${info.port}`);
});

// Graceful shutdown: stop accepting requests, flush the queue connection, exit.
// Railway sends SIGTERM on every redeploy; without this, in-flight enqueues die.
async function shutdown(signal: string) {
  console.log(`[oxyqa-webhook] ${signal} — shutting down`);
  server.close();
  await queue.close();
  redis.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
