import { commandHelp, commandJobId, type CommandJob, type PrJob } from "@oxyqa/core";

export interface CommandDependencies {
  slug: string;
  canWrite(job: CommandJob): Promise<boolean>;
  isPullRequest(job: CommandJob): Promise<boolean>;
  remember(job: CommandJob, text: string): Promise<void>;
  forget(job: CommandJob, match: string): Promise<number>;
  currentHead(job: CommandJob): Promise<string | null>;
  enqueue(job: PrJob, id: string): Promise<unknown>;
  acknowledge(job: CommandJob, text: string): Promise<void>;
}

/** GitHub permission is checked at execution time, never inferred from author_association. */
export async function processCommand(job: CommandJob, deps: CommandDependencies) {
  if (!(await deps.isPullRequest(job))) return { ignored: true };
  if (!(await deps.canWrite(job))) {
    await deps.acknowledge(job, "Only collaborators with repository write/admin access can run OxyQA commands.");
    return { denied: true };
  }
  const command = job.command;
  let reply: string;
  switch (command.type) {
    case "remember":
      await deps.remember(job, command.text);
      reply = "Saved repository guidance. It will apply to future plans; use regenerate to update this PR's plan.";
      break;
    case "forget": {
      const count = await deps.forget(job, command.match);
      reply = count ? `Forgot ${count} matching repository ${count === 1 ? "memory" : "memories"}.` : "No active repository memories match that text.";
      break;
    }
    case "focus":
    case "regenerate": {
      const headSha = await deps.currentHead(job);
      if (!headSha) {
        reply = "Regeneration is available on open, non-draft pull requests.";
        break;
      }
      await deps.enqueue({
        kind: "plan", installationId: job.installationId, owner: job.owner,
        repo: job.repo, prNumber: job.prNumber, headSha, action: "command",
        ...(command.type === "focus" ? { oneShotFocus: command.areas } : {}),
      }, `regenerate-${commandJobId(job)}`);
      reply = command.type === "focus" ? "Queued a new plan with one-time focus. Saved repository guidance is unchanged." : "Queued a new plan for the current PR head.";
      break;
    }
    default: reply = commandHelp(deps.slug);
  }
  await deps.acknowledge(job, reply);
  return { command: command.type };
}
