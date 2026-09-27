// Runtime wiring: GitHub/Redis/Postgres connections stay out of the tested handlers.
import { PR_QUEUE_NAME, createPrQueue, createRedisConnection, generateTestPlan, getConfig, type OxyqaJob } from "@oxyqa/core";
import { createDb, installations } from "@oxyqa/db";
import { Worker } from "bullmq";
import { App } from "octokit";
import { processCommand } from "./commands.js";
import { createMemoryStore } from "./memories.js";
import { writeBotComment } from "./github-comments.js";
import { processPlan } from "./plans.js";

const config = getConfig();
const connection = createRedisConnection(config.redisUrl);
const db = createDb(config.databaseUrl);
const githubApp = new App({ appId: config.github.appId, privateKey: config.github.privateKey });

const { data: identity } = await githubApp.octokit.rest.apps.getAuthenticated();
if (!identity?.slug) throw new Error("GitHub App slug is missing");
const slug = identity.slug;
const queue = createPrQueue(connection);
const memories = createMemoryStore(db);

async function ensureInstallation(installationId: number) {
  const { data } = await githubApp.octokit.rest.apps.getInstallation({ installation_id: installationId });
  if (data.suspended_at) throw new Error("GitHub App installation is suspended");
  await db.insert(installations).values({
    id: installationId, accountLogin: data.account && "login" in data.account ? data.account.login : "unknown",
    accountType: data.account && "type" in data.account ? data.account.type : "Organization",
  }).onConflictDoNothing();
}

const worker = new Worker<OxyqaJob>(
  PR_QUEUE_NAME,
  async (job) => {
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
        remember: async (c, text) => { await ensureInstallation(c.installationId); await memories.remember(c, text); },
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
    await ensureInstallation(job.data.installationId);
    return processPlan(job.data, {
      db, octokit: await githubApp.getInstallationOctokit(job.data.installationId), slug,
      model: config.llm.model, generate: (input) => generateTestPlan(config.llm, input),
    });
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
