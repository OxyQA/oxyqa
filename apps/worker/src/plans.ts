import {
  COMMENT_MARKER, REPO_CONFIG_PATH, describeFailure, formatRepoMemories, formatDiff,
  loadRepoContext, monthWindow, renderFailureComment, renderLimitComment, renderPlanComment,
  resolveMonthlyPlanLimit, resolveRepoConfig,
  type PrJob, type RepoContentReader, type PromptInput, type GenerateResult,
} from "@oxyqa/core";
import { installations, plans, testCases, usage, type Database } from "@oxyqa/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Octokit } from "octokit";
import { createMemoryStore } from "./memories.js";
import { findBotComment, writeBotComment } from "./github-comments.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Serializes publication per PR (across head SHAs): plan posts, regenerations
// and failure banners must not interleave on the one bot comment.
function lockPullRequest(tx: Tx, { installationId, owner, repo, prNumber }: PrJob) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${installationId}/${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`}, 0))`);
}

function planScope({ installationId, owner, repo, prNumber, headSha }: PrJob) {
  return and(eq(plans.installationId, installationId), eq(plans.owner, owner), eq(plans.repo, repo),
    eq(plans.prNumber, prNumber), eq(plans.headSha, headSha));
}

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

export interface PlanDependencies {
  db: Database;
  octokit: Octokit;
  slug: string;
  model: string;
  /** `metadata` carries ids only, for LLM tracing. */
  generate(input: PromptInput, metadata?: Record<string, string | number>): Promise<GenerateResult>;
  /** Cloud installs are capped per month; self-hosted is unlimited. Defaults to cloud. */
  mode?: "cloud" | "self-hosted";
  now?: () => Date;
}

/** All external boundaries are injected so the full flow can run offline. */
export async function processPlan(job: PrJob, { db, octokit, slug, model, generate, mode = "cloud", now = () => new Date() }: PlanDependencies) {
  const memories = createMemoryStore(db);
  const { installationId, owner, repo, prNumber, headSha, oneShotFocus } = job;
  const log = (msg: string) => console.log(`[oxyqa-worker] PR #${prNumber} — ${msg}`);
  log(`start (${owner}/${repo}@${headSha.slice(0, 7)})`);

  // The runtime ensures the installation exists before entering this handler.
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.head.sha !== headSha || pr.state !== "open" || pr.draft) return { skipped: "stale or closed PR" };
  const [planRow] = await db
    .insert(plans)
    .values({ installationId, owner, repo, prNumber, headSha, status: "processing" })
    .onConflictDoUpdate({
      target: [plans.installationId, plans.owner, plans.repo, plans.prNumber, plans.headSha],
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

  // 2. Free-tier gate, before any LLM spend. A soft cap: concurrent jobs can
  //    overshoot by at most the worker concurrency.
  const limit = resolveMonthlyPlanLimit(mode, installRow?.config);
  if (limit !== null) {
    const { start, resetsAt } = monthWindow(now());
    const [used] = await db.select({ n: count() }).from(usage)
      .where(and(eq(usage.installationId, installationId), gte(usage.createdAt, start)));
    if ((used?.n ?? 0) >= limit) {
      log(`monthly limit reached (${used?.n}/${limit}) — skipping generation`);
      return db.transaction(async (tx) => {
        await lockPullRequest(tx, job);
        const scope = { owner, repo, prNumber };
        const existing = await findBotComment(octokit, scope, slug, COMMENT_MARKER);
        const body = renderLimitComment(existing?.body ?? null, { limit, resetsAt, headSha, slug });
        const commentId = await writeBotComment(octokit, scope, slug, COMMENT_MARKER, body, existing?.id);
        await tx.update(plans).set({ status: "limited", updatedAt: new Date() }).where(eq(plans.id, planId));
        return { skipped: "monthly plan limit reached", commentId };
      });
    }
  }

  // 3. Fetch PR metadata + diff (skipPaths-filtered, budgeted).
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const diff = formatDiff(files, { skipPaths: repoConfig.skipPaths });
  log(
    `${files.length} files changed, ${diff.included} in diff (${diff.skipped} skipped by config, ${diff.omitted} over budget)`,
  );

  // 4. Load repo context (.oxyqa/context.md → README fallback) at the PR head.
  const repoContext = await loadRepoContext(reader, headSha);
  log(`context: ${repoContext.source}${repoContext.truncated ? " (truncated)" : ""}`);

  // 5. Generate the test plan (provider-agnostic LLM call).
  const { plan, promptVersion, usage: tokens } = await generate({
    prTitle: pr.title,
    prBody: pr.body ?? undefined,
    diff: diff.text,
    repoContext: repoContext.text,
    repoMemories: formatRepoMemories(await memories.load({ installationId, owner, repo })),
    oneShotFocus,
    behavior: { maxCases: repoConfig.maxCases, focusAreas: repoConfig.focusAreas },
  }, { installationId, repo: `${owner}/${repo}`, prNumber, headSha });
  log(
    `generated ${plan.testCases.length} test cases (${tokens.inputTokens}→${tokens.outputTokens} tok, cache read ${tokens.cacheReadInputTokens} / write ${tokens.cacheCreationInputTokens})`,
  );

  await db.insert(usage).values({
    installationId,
    repo,
    prNumber,
    model,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
  });

  // 6. Post or update the PR comment (idempotent via the hidden marker).
  const body = renderPlanComment(plan, { headSha, promptVersion }, repoConfig.commentStyle);
  // Concurrent regenerate jobs must not create duplicate comments or interleave case replacement.
  return db.transaction(async (tx) => {
    await lockPullRequest(tx, job);
    const { data: latest } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (latest.head.sha !== headSha || latest.state !== "open" || latest.draft) {
      await tx.update(plans).set({ status: "superseded", updatedAt: new Date() }).where(eq(plans.id, planId));
      return { skipped: "PR changed during generation" };
    }
    const commentId = await writeBotComment(octokit, { owner, repo, prNumber }, slug, COMMENT_MARKER, body);
    log(`posted plan comment ${commentId}`);

    // 7. Atomically persist plan status and replace its cases on regeneration.
    await tx
      .update(plans)
      .set({ status: "posted", commentId, promptVersion, updatedAt: new Date() })
      .where(eq(plans.id, planId));
    await tx.delete(testCases).where(eq(testCases.planId, planId));
    await tx.insert(testCases).values(
      plan.testCases.map((tc) => ({
        planId,
        title: tc.title,
        description: tc.description,
        steps: tc.steps,
        expected: tc.expected,
        priority: tc.priority,
      })),
    );

    return { testCases: plan.testCases.length, commentId };
  });
}

export interface FailureDependencies {
  db: Database;
  octokit: Octokit;
  slug: string;
  /** When the failing attempt started; a plan posted after it wins. */
  attemptStartedAt: Date;
}

/**
 * Final-attempt failure UX (DECISIONS §5.2): mark the plan failed and put a
 * one-line reason + retry hint on the bot comment, without discarding a
 * previous plan. Stale PRs and runs overtaken by a later success stay quiet.
 */
export async function reportPlanFailure(job: PrJob, err: unknown, { db, octokit, slug, attemptStartedAt }: FailureDependencies) {
  const { owner, repo, prNumber, headSha } = job;
  const reason = describeFailure(err);
  return db.transaction(async (tx) => {
    await lockPullRequest(tx, job);
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (pr.head.sha !== headSha || pr.state !== "open" || pr.draft) return { skipped: "stale or closed PR" };
    const [row] = await tx.select({ status: plans.status, updatedAt: plans.updatedAt }).from(plans).where(planScope(job));
    if (row?.status === "posted" && row.updatedAt >= attemptStartedAt) return { skipped: "a later run succeeded" };
    const scope = { owner, repo, prNumber };
    const existing = await findBotComment(octokit, scope, slug, COMMENT_MARKER);
    const body = renderFailureComment(existing?.body ?? null, { reason, headSha, slug });
    const commentId = await writeBotComment(octokit, scope, slug, COMMENT_MARKER, body, existing?.id);
    await tx.update(plans).set({ status: "failed", updatedAt: new Date() }).where(planScope(job));
    return { failed: reason, commentId };
  });
}
