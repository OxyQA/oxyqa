// Runtime wiring: GitHub/Redis/Postgres connections stay out of the tested handlers.
import {
  PR_QUEUE_NAME, createErrorReporter, createLlmObserver, createPrQueue, createRedisConnection,
  generateTestPlan, getConfig, interpretRoutedCommand, routeCommand, type OxyqaJob,
} from "@oxyqa/core";
import { createDb } from "@oxyqa/db";
import { Worker } from "bullmq";
import { App } from "octokit";
import { runCommand } from "./commands.js";
import { collectFeedback } from "./feedback.js";
import { purgeUninstalled, syncInstallation, type GitHubInstallation } from "./installations.js";
import { createMemoryStore } from "./memories.js";
import { writeBotComment } from "./github-comments.js";
import { processPlan, reportPlanFailure } from "./plans.js";
import { upsertTrackingIssue } from "./tracking-issue.js";

const config = getConfig();
const errors = await createErrorReporter(config.errorReporting, "worker");
const llmObserver = await createLlmObserver(config.llmTracing);
const connection = createRedisConnection(config.redisUrl);
const db = createDb(config.databaseUrl);
const githubApp = new App({ appId: config.github.appId, privateKey: config.github.privateKey });

const { data: identity } = await githubApp.octokit.rest.apps.getAuthenticated();
if (!identity?.slug) throw new Error("GitHub App slug is missing");
const slug = identity.slug;
const queue = createPrQueue(connection);
const memories = createMemoryStore(db);

async function fetchInstallation(installationId: number): Promise<GitHubInstallation | null> {
  try {
    const { data } = await githubApp.octokit.rest.apps.getInstallation({ installation_id: installationId });
    return data as GitHubInstallation;
  } catch (err) { if ((err as { status?: number }).status === 404) return null; throw err; }
}

const worker = new Worker<OxyqaJob>(
  PR_QUEUE_NAME,
  async (job) => {
    // Every job refreshes its installation row; only active installs do work.
    const state = await syncInstallation(db, job.data.installationId, fetchInstallation);
    if (job.data.kind === "installation") {
      console.log(`[oxyqa-worker] installation ${job.data.installationId} ${job.data.action} → ${state}`);
      return { installation: state };
    }
    if (state !== "active") return { skipped: `installation ${state}` };
    if (job.data.kind === "feedback") {
      return collectFeedback(job.data, { db, octokit: await githubApp.getInstallationOctokit(job.data.installationId) });
    }
    if (job.data.kind === "command") {
      const command = job.data;
      const octokit = await githubApp.getInstallationOctokit(command.installationId);
      const scope = { owner: command.owner, repo: command.repo };
      const acknowledge = async (c: typeof command, text: string) => {
        const marker = `<!-- oxyqa:command:${c.commentId} -->`;
        await writeBotComment(octokit, c, slug, marker, `${marker}\n${text}`);
      };
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return runCommand(command, isFinalAttempt, {
        slug,
        isPullRequest: async () => {
          try {
            await octokit.rest.pulls.get({ ...scope, pull_number: command.prNumber });
            return true;
          } catch (err) { if ((err as { status?: number }).status === 404) return false; throw err; }
        },
        canWrite: async () => {
          const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ ...scope, username: command.actor });
          return data.permission === "admin" || data.permission === "write" || data.user?.permissions?.push === true;
        },
        remember: (c, text) => memories.remember(c, text),
        forget: (c, match) => memories.forget(c, match),
        interpret: async (c, text) => {
          const saved = await memories.list(c);
          const routed = await routeCommand(
            { ...config.llm, model: config.llm.routerModel },
            { comment: text, memories: saved.map((m) => m.content) },
            { observer: llmObserver, metadata: { installationId: c.installationId, repo: `${c.owner}/${c.repo}`, prNumber: c.prNumber } },
          );
          return interpretRoutedCommand(routed, saved);
        },
        forgetIds: (c, ids) => memories.forgetIds(c, ids),
        createIssue: (c) => upsertTrackingIssue(c, { db, octokit }),
        currentHead: async () => {
          const { data } = await octokit.rest.pulls.get({ ...scope, pull_number: command.prNumber });
          return data.state === "open" && !data.draft ? data.head.sha : null;
        },
        enqueue: (data, jobId) => queue.add("process-pr", data, { jobId }),
        acknowledge,
      });
    }
    const plan = job.data;
    const octokit = await githubApp.getInstallationOctokit(plan.installationId);
    try {
      return await processPlan(plan, {
        db, octokit, slug, mode: config.mode, model: config.llm.model,
        generate: (input, metadata) => generateTestPlan(config.llm, input, { observer: llmObserver, metadata }),
      });
    } catch (err) {
      // attemptsMade counts earlier failures while this attempt is still running.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        const attemptStartedAt = new Date(job.processedOn ?? Date.now());
        await reportPlanFailure(plan, err, { db, octokit, slug, attemptStartedAt })
          .then((r) => console.log(`[oxyqa-worker] PR #${plan.prNumber} — final failure reported: ${JSON.stringify(r)}`))
          .catch((e) => {
            console.error(`[oxyqa-worker] PR #${plan.prNumber} — could not report failure:`, (e as Error).message);
            errors.capture(e, { stage: "report-failure", installationId: plan.installationId, repo: `${plan.owner}/${plan.repo}`, prNumber: plan.prNumber });
          });
      }
      throw err;
    }
  },
  {
    connection,
    concurrency: 5,
    // Idle cost control (measured 2026-10-02): the defaults poll Redis ~39
    // times per 90 s when idle (~1.1M commands/month); these settings bring
    // that to ~2. New jobs still wake the worker at once (~0.1–0.2 s pickup),
    // because adding a job unblocks the wait. The trade-off is that a job
    // orphaned by a crashed worker is retried after up to 2 minutes, not 30 s.
    drainDelay: 60,
    stalledInterval: 120_000,
  },
);

worker.on("completed", (job) => console.log(`[oxyqa-worker] job ${job.id} done`));
worker.on("failed", (job, err) => {
  console.error(`[oxyqa-worker] job ${job?.id} failed:`, err.message);
  // Report once per job, on the final attempt (attemptsMade is already incremented here).
  if (!job || job.attemptsMade >= (job.opts.attempts ?? 1)) {
    const d = job?.data;
    errors.capture(err, {
      kind: d?.kind ?? "plan", installationId: d?.installationId,
      repo: d && "repo" in d ? `${d.owner}/${d.repo}` : undefined,
      prNumber: d && "prNumber" in d ? d.prNumber : undefined,
    });
  }
});
worker.on("error", (err) => errors.capture(err, { stage: "worker" }));

console.log(`[oxyqa-worker] observability: errors=${errors.enabled ? "sentry" : "off"}, llm=${llmObserver ? "langfuse" : "off"}`);

console.log(`[oxyqa-worker] listening on queue "${PR_QUEUE_NAME}"`);

// Retention: purge data of installations uninstalled more than 30 days ago.
// Runs at boot and every 6 hours; failures are reported and retried next tick.
async function purge() {
  try {
    const purged = await purgeUninstalled(db);
    if (purged) console.log(`[oxyqa-worker] retention: purged ${purged} uninstalled installation(s)`);
  } catch (err) {
    console.error("[oxyqa-worker] retention purge failed:", (err as Error).message);
    errors.capture(err, { stage: "retention" });
  }
}
void purge();
setInterval(() => void purge(), 6 * 3_600_000).unref();

// Graceful shutdown: worker.close() waits for active jobs to finish before
// resolving, so a Railway redeploy never kills a plan mid-generation.
async function shutdown(signal: string) {
  console.log(`[oxyqa-worker] ${signal} — draining (waiting for active jobs)`);
  await worker.close();
  await queue.close();
  connection.disconnect();
  await Promise.all([errors.shutdown(), llmObserver?.shutdown()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
