// @oxyqa/worker — async processing (BullMQ consumer).
//
// This increment proves the full ingress→queue→GitHub-auth chain: pull a job,
// authenticate as the installation, fetch the PR's changed files, log a summary.
//
// NEXT (Phase 1 completion):
//   - parse hunks/symbols from the diff (parse-diff)
//   - enrich context (.oxyqa/context.md, docs, linked tickets)
//   - generateObject() with a Zod test-case schema (@oxyqa/core/llm)
//   - post/update a PR comment, persist the plan + test cases to @oxyqa/db
import { PR_QUEUE_NAME, createRedisConnection, getConfig, type PrJob } from "@oxyqa/core";
import { Worker } from "bullmq";
import { App } from "octokit";

const config = getConfig();
const connection = createRedisConnection(config.redisUrl);

// GitHub App: one App instance, per-installation Octokit minted per job (JWT →
// short-lived installation token, cached by Octokit).
const githubApp = new App({
  appId: config.github.appId,
  privateKey: config.github.privateKey,
});

const worker = new Worker<PrJob>(
  PR_QUEUE_NAME,
  async (job) => {
    const { installationId, owner, repo, prNumber, headSha } = job.data;
    console.log(`[oxyqa-worker] PR #${prNumber} (${owner}/${repo}@${headSha.slice(0, 7)}) — start`);

    const octokit = await githubApp.getInstallationOctokit(installationId);
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const changed = files.length;
    const additions = files.reduce((n, f) => n + f.additions, 0);
    const deletions = files.reduce((n, f) => n + f.deletions, 0);
    console.log(
      `[oxyqa-worker] PR #${prNumber} — ${changed} files changed (+${additions}/-${deletions})`,
    );

    // TODO(Phase 1): diff parse → context enrich → generateObject → PR comment → persist.
    return { changed, additions, deletions };
  },
  { connection, concurrency: 5 },
);

worker.on("completed", (job) => console.log(`[oxyqa-worker] job ${job.id} done`));
worker.on("failed", (job, err) => console.error(`[oxyqa-worker] job ${job?.id} failed:`, err.message));

console.log(`[oxyqa-worker] listening on queue "${PR_QUEUE_NAME}"`);
