// Runtime wiring: GitHub/Redis/Postgres connections stay out of the tested handlers.
import { PR_QUEUE_NAME, createPrQueue, createRedisConnection, generateTestPlan, getConfig, type OxyqaJob } from "@oxyqa/core";
import { createDb } from "@oxyqa/db";
import { Worker } from "bullmq";
import { App } from "octokit";
import { processCommand } from "./commands.js";
import { syncInstallation, type GitHubInstallation } from "./installations.js";
import { createMemoryStore } from "./memories.js";
import { writeBotComment } from "./github-comments.js";
import { processPlan, reportPlanFailure } from "./plans.js";

const config = getConfig();
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
    if (job.data.kind === "command") {
      const command = job.data;
      const octokit = await githubApp.getInstallationOctokit(command.installationId);
      const scope = { owner: command.owner, repo: command.repo };
      return processCommand(command, {
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
        currentHead: async () => {
          const { data } = await octokit.rest.pulls.get({ ...scope, pull_number: command.prNumber });
          return data.state === "open" && !data.draft ? data.head.sha : null;
        },
        enqueue: (data, jobId) => queue.add("process-pr", data, { jobId }),
        acknowledge: async (c, text) => {
          const marker = `<!-- oxyqa:command:${c.commentId} -->`;
          await writeBotComment(octokit, c, slug, marker, `${marker}\n${text}`);
        },
      });
    }
    const plan = job.data;
    const octokit = await githubApp.getInstallationOctokit(plan.installationId);
    try {
      return await processPlan(plan, {
        db, octokit, slug, mode: config.mode, model: config.llm.model, generate: (input) => generateTestPlan(config.llm, input),
      });
    } catch (err) {
      // attemptsMade counts earlier failures while this attempt is still running.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        const attemptStartedAt = new Date(job.processedOn ?? Date.now());
        await reportPlanFailure(plan, err, { db, octokit, slug, attemptStartedAt })
          .then((r) => console.log(`[oxyqa-worker] PR #${plan.prNumber} — final failure reported: ${JSON.stringify(r)}`))
          .catch((e) => console.error(`[oxyqa-worker] PR #${plan.prNumber} — could not report failure:`, (e as Error).message));
      }
      throw err;
    }
  },
  { connection, concurrency: 5 },
);

worker.on("completed", (job) => console.log(`[oxyqa-worker] job ${job.id} done`));
worker.on("failed", (job, err) => console.error(`[oxyqa-worker] job ${job?.id} failed:`, err.message));

console.log(`[oxyqa-worker] listening on queue "${PR_QUEUE_NAME}"`);

// Graceful shutdown: worker.close() waits for active jobs to finish before
// resolving, so a Railway redeploy never kills a plan mid-generation.
async function shutdown(signal: string) {
  console.log(`[oxyqa-worker] ${signal} — draining (waiting for active jobs)`);
  await worker.close();
  await queue.close();
  connection.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
