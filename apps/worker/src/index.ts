// @oxyqa/worker — async processing (BullMQ consumer).
//
// The core loop: pull a job → auth as the installation → fetch diff → generate
// a test plan → post/update the PR comment → persist plan, cases, and usage.
import {
  COMMENT_MARKER,
  PR_QUEUE_NAME,
  REPO_CONFIG_PATH,
  type PrJob,
  type RepoContentReader,
  createRedisConnection,
  formatDiff,
  generateTestPlan,
  getConfig,
  loadRepoContext,
  renderPlanComment,
  resolveRepoConfig,
} from "@oxyqa/core";
import { createDb, installations, plans, testCases, usage } from "@oxyqa/db";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { App, type Octokit } from "octokit";

// Adapts an installation Octokit onto core's minimal read surface so the
// context loader stays GitHub-client-agnostic.
function makeContentReader(octokit: Octokit, owner: string, repo: string): RepoContentReader {
  const is404 = (err: unknown) => (err as { status?: number }).status === 404;
  return {
    async readFile(path, ref) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
        if (Array.isArray(data) || data.type !== "file") return null;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (err) {
        if (is404(err)) return null;
        throw err;
      }
    },
    async readReadme(ref) {
      try {
        const { data } = await octokit.rest.repos.getReadme({ owner, repo, ref });
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (err) {
        if (is404(err)) return null;
        throw err;
      }
    },
  };
}

const config = getConfig();
const connection = createRedisConnection(config.redisUrl);
const db = createDb(config.databaseUrl);
const githubApp = new App({ appId: config.github.appId, privateKey: config.github.privateKey });

const worker = new Worker<PrJob>(
  PR_QUEUE_NAME,
  async (job) => {
    const { installationId, owner, repo, prNumber, headSha } = job.data;
    const log = (msg: string) => console.log(`[oxyqa-worker] PR #${prNumber} — ${msg}`);
    log(`start (${owner}/${repo}@${headSha.slice(0, 7)})`);

    const octokit = await githubApp.getInstallationOctokit(installationId);

    // Tenant + plan rows up front so the plan exists (idempotent) even if we fail later.
    await db
      .insert(installations)
      .values({ id: installationId, accountLogin: owner, accountType: "Organization" })
      .onConflictDoNothing();
    const [planRow] = await db
      .insert(plans)
      .values({ installationId, owner, repo, prNumber, headSha, status: "processing" })
      .onConflictDoUpdate({
        target: [plans.installationId, plans.repo, plans.headSha],
        set: { status: "processing", updatedAt: new Date() },
      })
      .returning({ id: plans.id });
    const planId = planRow!.id;

    // 1. Resolve behavior config: defaults ← repo .oxyqa/config.yml ← install
    //    JSONB overrides. Bad config warns and falls back — never fails a plan.
    const reader = makeContentReader(octokit, owner, repo);
    const [installRow] = await db
      .select({ config: installations.config })
      .from(installations)
      .where(eq(installations.id, installationId));
    const repoYaml = await reader.readFile(REPO_CONFIG_PATH, headSha);
    const { config: repoConfig, sources, warnings } = resolveRepoConfig({
      repoYaml,
      installOverrides: installRow?.config,
    });
    for (const w of warnings) log(`config warning: ${w}`);
    log(
      `config: ${sources.join("+")} (maxCases=${repoConfig.maxCases}, commentStyle=${repoConfig.commentStyle}, focusAreas=${repoConfig.focusAreas.length}, skipPaths=${repoConfig.skipPaths.length})`,
    );

    // 2. Fetch PR metadata + diff (skipPaths-filtered, budgeted).
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const diff = formatDiff(files, { skipPaths: repoConfig.skipPaths });
    log(
      `${files.length} files changed, ${diff.included} in diff (${diff.skipped} skipped by config, ${diff.omitted} over budget)`,
    );

    // 3. Load repo context (.oxyqa/context.md → README fallback) at the PR head.
    const repoContext = await loadRepoContext(reader, headSha);
    log(`context: ${repoContext.source}${repoContext.truncated ? " (truncated)" : ""}`);

    // 4. Generate the test plan (provider-agnostic LLM call).
    const { plan, promptVersion, usage: tokens } = await generateTestPlan(config.llm, {
      prTitle: pr.title,
      prBody: pr.body ?? undefined,
      diff: diff.text,
      repoContext: repoContext.text,
      behavior: { maxCases: repoConfig.maxCases, focusAreas: repoConfig.focusAreas },
    });
    log(
      `generated ${plan.testCases.length} test cases (${tokens.inputTokens}→${tokens.outputTokens} tok, cache read ${tokens.cacheReadInputTokens} / write ${tokens.cacheCreationInputTokens})`,
    );

    // 5. Post or update the PR comment (idempotent via the hidden marker).
    const body = renderPlanComment(plan, { headSha, promptVersion }, repoConfig.commentStyle);
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    let commentId: number;
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      commentId = existing.id;
      log(`updated comment ${commentId}`);
    } else {
      const { data: created } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      commentId = created.id;
      log(`posted comment ${commentId}`);
    }

    // 6. Persist: plan status, test cases (replace on re-run), metered usage.
    await db
      .update(plans)
      .set({ status: "posted", commentId, promptVersion, updatedAt: new Date() })
      .where(eq(plans.id, planId));
    await db.delete(testCases).where(eq(testCases.planId, planId));
    await db.insert(testCases).values(
      plan.testCases.map((tc) => ({
        planId,
        title: tc.title,
        description: tc.description,
        steps: tc.steps,
        expected: tc.expected,
        priority: tc.priority,
      })),
    );
    await db.insert(usage).values({
      installationId,
      repo,
      prNumber,
      model: config.llm.model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
    });

    return { testCases: plan.testCases.length, commentId };
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
  connection.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
