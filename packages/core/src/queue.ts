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

export type OxyqaJob = PrJob | CommandJob;

export function planJobId(job: PrJob): string {
  const scope = [job.installationId, job.owner.toLowerCase(), job.repo.toLowerCase(), job.prNumber, job.headSha];
  return `plan-${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
}

export function commandJobId(job: Pick<CommandJob, "installationId" | "commentId">): string {
  return `command-${job.installationId}-${job.commentId}`;
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
