import { verify } from "@octokit/webhooks-methods";
import { commandJobId, feedbackJobId, installationJobId, parseAgentCommand, planJobId, type OxyqaJob } from "@oxyqa/core";
import { Hono } from "hono";
import { z } from "zod";

const base = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({ name: z.string().min(1), owner: z.object({ login: z.string().min(1) }) }),
});
const prEvent = base.extend({
  pull_request: z.object({ number: z.number().int().positive(), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }), draft: z.boolean().optional() }),
});
const commentEvent = base.extend({
  issue: z.object({ number: z.number().int().positive(), pull_request: z.object({}).optional() }),
  comment: z.object({ id: z.number().int().positive(), body: z.string(), user: z.object({ login: z.string(), type: z.string() }) }),
});
// No repository on installation events; deleted installs still carry their id.
const installationEvent = z.object({ action: z.string(), installation: z.object({ id: z.number().int().positive() }) });
const installationEvents = new Set(["installation", "installation_repositories"]);
const actions = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export interface WebhookDependencies {
  secret: string;
  slug: string;
  ping(): Promise<unknown>;
  enqueue(job: OxyqaJob, id: string): Promise<unknown>;
  /** Unhandled route errors (e.g. Redis down). GitHub sees a 500 and redelivers. */
  reportError?(err: unknown, context: { event?: string }): void;
}

/** No connections at import time: signed webhook tests run entirely offline. */
export function createWebhookApp(deps: WebhookDependencies) {
  const app = new Hono();
  app.onError((err, c) => {
    console.error("[oxyqa-webhook] unhandled error:", err.message);
    deps.reportError?.(err, { event: c.req.header("x-github-event") });
    return c.json({ error: "internal error" }, 500);
  });
  app.get("/", (c) => c.json({ service: "oxyqa-webhook", ok: true }));
  app.get("/health", async (c) => {
    try { await deps.ping(); return c.json({ ok: true, redis: "up" }); }
    catch { return c.json({ ok: false, redis: "down" }, 503); }
  });
  app.post("/webhooks/github", async (c) => {
    const raw = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!signature || !(await verify(deps.secret, raw, signature))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const event = c.req.header("x-github-event");
    if (event !== "pull_request" && event !== "issue_comment" && !installationEvents.has(event ?? "")) {
      return c.json({ ok: true, ignored: event });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { return c.json({ error: "invalid JSON" }, 400); }

    if (installationEvents.has(event!)) {
      const parsed = installationEvent.safeParse(payload);
      if (!parsed.success) return c.json({ error: "invalid installation event" }, 400);
      const job = { kind: "installation" as const, installationId: parsed.data.installation.id, action: `${event}.${parsed.data.action}` };
      // Redeliveries reuse the delivery GUID; the raw body is a stable fallback.
      await deps.enqueue(job, installationJobId(job, c.req.header("x-github-delivery") ?? raw));
      return c.json({ ok: true, queued: job.action });
    }

    if (event === "issue_comment") {
      const parsed = commentEvent.safeParse(payload);
      if (!parsed.success) return c.json({ error: "invalid comment event" }, 400);
      const p = parsed.data;
      if (p.action !== "created" || !p.issue.pull_request || p.comment.user.type !== "User" || p.comment.user.login.endsWith("[bot]")) {
        return c.json({ ok: true, ignored: true });
      }
      const command = parseAgentCommand(p.comment.body, deps.slug);
      if (!command) return c.json({ ok: true, ignored: true });
      const job = {
        kind: "command" as const, installationId: p.installation.id,
        owner: p.repository.owner.login, repo: p.repository.name,
        prNumber: p.issue.number, commentId: p.comment.id, actor: p.comment.user.login, command,
      };
      await deps.enqueue(job, commandJobId(job));
      return c.json({ ok: true, queued: p.comment.id });
    }
    const parsed = prEvent.safeParse(payload);
    if (!parsed.success) return c.json({ error: "invalid pull request event" }, 400);
    const p = parsed.data;
    if (p.action === "closed") {
      // Reactions have no webhook; the close event is the cue to collect them.
      const job = { kind: "feedback" as const, installationId: p.installation.id, owner: p.repository.owner.login, repo: p.repository.name, prNumber: p.pull_request.number };
      await deps.enqueue(job, feedbackJobId(job, c.req.header("x-github-delivery") ?? raw));
      return c.json({ ok: true, queued: "feedback" });
    }
    if (!actions.has(p.action) || p.pull_request.draft) return c.json({ ok: true, skipped: p.action });
    const job = {
      installationId: p.installation.id, owner: p.repository.owner.login,
      repo: p.repository.name, prNumber: p.pull_request.number,
      headSha: p.pull_request.head.sha, action: p.action,
    };
    // BullMQ atomically deduplicates. No preceding Redis claim that could lose
    // a delivery when enqueue fails after claiming it.
    await deps.enqueue(job, planJobId(job));
    return c.json({ ok: true, queued: job.prNumber });
  });
  return app;
}
