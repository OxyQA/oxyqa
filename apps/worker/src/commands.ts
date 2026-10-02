import { commandHelp, commandJobId, describeFailure, type CommandJob, type Interpretation, type PrJob } from "@oxyqa/core";
import type { TrackingIssueResult } from "./tracking-issue.js";

export interface CommandDependencies {
  slug: string;
  canWrite(job: CommandJob): Promise<boolean>;
  isPullRequest(job: CommandJob): Promise<boolean>;
  remember(job: CommandJob, text: string): Promise<void>;
  forget(job: CommandJob, match: string): Promise<number>;
  /** Routes free text to an action (model call). */
  interpret(job: CommandJob, text: string): Promise<Interpretation>;
  forgetIds(job: CommandJob, ids: string[]): Promise<number>;
  createIssue(job: CommandJob): Promise<TrackingIssueResult>;
  currentHead(job: CommandJob): Promise<string | null>;
  enqueue(job: PrJob, id: string): Promise<unknown>;
  acknowledge(job: CommandJob, text: string): Promise<void>;
}

const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");

/** GitHub permission is checked at execution time, never inferred from author_association. */
export async function processCommand(job: CommandJob, deps: CommandDependencies) {
  if (!(await deps.isPullRequest(job))) return { ignored: true };
  if (!(await deps.canWrite(job))) {
    await deps.acknowledge(job, "Only collaborators with repository write/admin access can run OxyQA commands.");
    return { denied: true };
  }
  const command = job.command;
  // Free text is routed only after the permission check, and its result is
  // always echoed so a misreading is visible and reversible.
  let action: Interpretation | { type: "forget-match"; match: string };
  const routed = command.type === "freeform";
  if (command.type === "freeform") {
    try { action = await deps.interpret(job, command.text); }
    catch (err) {
      console.error(`[oxyqa-worker] command ${job.commentId} — could not interpret:`, (err as Error).message);
      await deps.acknowledge(job, `I couldn't interpret that just now. The exact commands still work:\n\n${commandHelp(deps.slug)}`);
      return { command: "freeform", interpreted: "error" };
    }
  } else if (command.type === "forget") action = { type: "forget-match", match: command.match };
  else if (command.type === "focus") action = { type: "focus", areas: command.areas };
  else action = command;

  let reply: string;
  switch (action.type) {
    case "remember":
      await deps.remember(job, action.text);
      reply = routed
        ? `Saved repository guidance:\n\n${quote(action.text)}\n\nIt will apply to future plans; use regenerate to update this PR's plan. If I got it wrong, tell me to forget it.`
        : "Saved repository guidance. It will apply to future plans; use regenerate to update this PR's plan.";
      break;
    case "forget-match": {
      const count = await deps.forget(job, action.match);
      reply = count ? `Forgot ${count} matching repository ${count === 1 ? "memory" : "memories"}.` : "No active repository memories match that text.";
      break;
    }
    case "forget": {
      const count = await deps.forgetIds(job, action.memories.map((m) => m.id));
      reply = count
        ? `Forgot ${count === 1 ? "this repository memory" : `these ${count} repository memories`}:\n\n${action.memories.map((m) => `- ${m.content}`).join("\n")}`
        : "I couldn't find a saved repository memory matching that, so nothing was removed.";
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
        ...(action.type === "focus" ? { oneShotFocus: action.areas } : {}),
      }, `regenerate-${commandJobId(job)}`);
      if (action.type !== "focus") reply = "Queued a new plan for the current PR head.";
      else if (routed) reply = `Queued a new plan with one-time focus on:\n\n${quote(action.areas)}\n\nSaved repository guidance is unchanged.`;
      else reply = "Queued a new plan with one-time focus. Saved repository guidance is unchanged.";
      break;
    }
    case "create-issue": {
      const result = await deps.createIssue(job);
      if (result.status === "created") reply = `Opened #${result.number} with this plan as a checklist.`;
      else if (result.status === "updated") reply = `Updated #${result.number} with the current plan. Its checkboxes were reset.`;
      else if (result.status === "no-plan") reply = `There's no test plan on this pull request yet. Comment \`@${deps.slug} regenerate\` first.`;
      else if (result.status === "issues-disabled") reply = "Issues are disabled for this repository, so I can't open a tracking issue.";
      else reply = "I need the **Issues: write** permission to open a tracking issue. An organization owner can approve the updated permissions in the app's installation settings.";
      break;
    }
    default:
      reply = routed ? `I'm not sure what to do with that. Here's what I can do:\n\n${commandHelp(deps.slug)}` : commandHelp(deps.slug);
  }
  await deps.acknowledge(job, reply);
  return routed ? { command: "freeform", interpreted: action.type } : { command: command.type };
}

/**
 * Runs a command and, when its final attempt fails, tells the commenter
 * instead of failing silently. The reply reuses the command's own marker, so
 * it lands in the same comment a successful retry would have written. The
 * original error is always rethrown for the queue and error reporting.
 */
export async function runCommand(job: CommandJob, isFinalAttempt: boolean, deps: CommandDependencies) {
  try {
    return await processCommand(job, deps);
  } catch (err) {
    if (isFinalAttempt) {
      await deps.acknowledge(job, `I couldn't complete that: ${describeFailure(err)}. Nothing may have changed — post the comment again to retry.`)
        .catch((e) => console.error(`[oxyqa-worker] command ${job.commentId} — could not report failure:`, (e as Error).message));
    }
    throw err;
  }
}
