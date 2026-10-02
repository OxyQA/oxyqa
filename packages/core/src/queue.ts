// The durable boundary between the fast webhook and the slow worker.
// Producer (webhook) and consumer (worker) share this job contract so a change
// to the payload is a single-source type change, not a two-service drift.
import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { AgentCommand } from "./commands.js";

// No ':' — BullMQ reserves the colon as its internal Redis key separator and
// rejects queue names that contain it.
export const PR_QUEUE_NAME = "oxyqa-pr";

/** One unit of work: a pull request event that needs a QA test plan. */
export interface PrJob {
  kind?: "plan";
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  action: string;
  oneShotFocus?: string;
}

export interface CommandJob {
  kind: "command";
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  actor: string;
  command: AgentCommand;
}

/** Install lifecycle event; the worker re-reads current state from GitHub. */
export interface InstallationJob {
  kind: "installation";
  installationId: number;
  action: string;
}

/** Collect 👍/👎 reactions on a PR's plan comment (sent when the PR closes). */
export interface FeedbackJob {
  kind: "feedback";
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
}

export type OxyqaJob = PrJob | CommandJob | InstallationJob | FeedbackJob;

/** BullMQ queue job name for each job kind. */
export function jobName(job: OxyqaJob): string {
  return job.kind === "command" || job.kind === "installation" || job.kind === "feedback" ? job.kind : "process-pr";
}

export function planJobId(job: PrJob): string {
  const scope = [job.installationId, job.owner.toLowerCase(), job.repo.toLowerCase(), job.prNumber, job.headSha];
  return `plan-${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
}

export function commandJobId(job: Pick<CommandJob, "installationId" | "commentId">): string {
  return `command-${job.installationId}-${job.commentId}`;
}

/**
 * One job per delivery, never per installation: retained completed jobs would
 * otherwise swallow a later suspend/unsuspend for the same installation.
 */
export function installationJobId(job: Pick<InstallationJob, "installationId">, deliveryId: string): string {
  return `installation-${job.installationId}-${createHash("sha256").update(deliveryId).digest("hex").slice(0, 32)}`;
}

/** Per delivery: a PR can close, reopen and close again, and each close re-collects. */
export function feedbackJobId(job: Pick<FeedbackJob, "installationId" | "prNumber">, deliveryId: string): string {
  return `feedback-${job.installationId}-${job.prNumber}-${createHash("sha256").update(deliveryId).digest("hex").slice(0, 32)}`;
}

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection. Upstash (and
 * any managed Redis over TLS) works through the rediss:// URL scheme unchanged —
 * this is what keeps cloud and self-hosted on one code path.
 */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** Producer-side handle. Stable scoped IDs deduplicate redeliveries while retained. */
export function createPrQueue(connection: Redis) {
  return new Queue<OxyqaJob>(PR_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}
