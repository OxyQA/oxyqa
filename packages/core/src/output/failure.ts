// Notices on the plan comment: final-failure UX (§5.2) and the monthly-limit
// notice (§5.4). One notice block at a time is prepended to the bot comment; a
// previous plan stays visible below it and the next successful run replaces
// the whole body.
import { COMMENT_MARKER } from "./comment.js";

const NOTICE_START = "<!-- oxyqa:notice -->";
const NOTICE_END = "<!-- /oxyqa:notice -->";

interface ErrorShape { name?: string; status?: number; statusCode?: number; lastError?: unknown }

/**
 * One-line, user-safe failure reason. Reasons are fixed phrases — raw error
 * messages can carry hosts, ids or stack detail and stay in worker logs only.
 * Duck-typed so core needs no SDK error classes.
 */
export function describeFailure(err: unknown): string {
  const e = (err ?? {}) as ErrorShape;
  if (e.name === "AI_RetryError" && e.lastError) return describeFailure(e.lastError);
  if (e.name === "AI_NoObjectGeneratedError" || e.name === "AI_TypeValidationError" || e.name === "AI_JSONParseError") {
    return "the model returned a plan in an unexpected format";
  }
  if (e.name === "AI_APICallError") {
    const s = e.statusCode;
    if (s === 429 || (s !== undefined && s >= 500)) return "the model provider was overloaded or unavailable";
    if (s === 401 || s === 403) return "OxyQA's model credentials were rejected (a configuration problem on our side)";
    return `the model provider rejected the request${s ? ` (HTTP ${s})` : ""}`;
  }
  if (e.name === "HttpError" && typeof e.status === "number") {
    if (e.status === 403 || e.status === 429) return `GitHub refused or rate-limited a request (HTTP ${e.status})`;
    return `a GitHub API request failed (HTTP ${e.status})`;
  }
  return "an unexpected internal error";
}

/** Prepends `lines` as the single notice block, replacing any earlier notice. */
function renderNotice(previous: string | null, kind: "WARNING" | "NOTE", lines: string[]): string {
  const rest = (previous ?? "")
    .replace(COMMENT_MARKER, "")
    .replace(new RegExp(`${NOTICE_START}[\\s\\S]*?${NOTICE_END}`), "")
    .trim();
  const body = [...lines];
  if (rest) body[body.length - 1] += " The plan below is from an earlier run.";
  const notice = [NOTICE_START, `> [!${kind}]`, ...body.map((l) => `> ${l}`), NOTICE_END].join("\n");
  return [COMMENT_MARKER, notice, ...(rest ? ["", rest] : [])].join("\n");
}

export interface FailureMeta {
  reason: string;
  headSha: string;
  slug: string;
}

export function renderFailureComment(previous: string | null, { reason, headSha, slug }: FailureMeta): string {
  return renderNotice(previous, "WARNING", [
    `OxyQA couldn't generate a test plan for \`${headSha.slice(0, 7)}\`: ${reason}.`,
    `Comment \`@${slug} regenerate\` to retry.`,
  ]);
}

export interface LimitMeta {
  limit: number;
  resetsAt: Date;
  headSha: string;
  slug: string;
}

export function renderLimitComment(previous: string | null, { limit, resetsAt, headSha, slug }: LimitMeta): string {
  const date = resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return renderNotice(previous, "NOTE", [
    `OxyQA has reached this installation's limit of ${limit} test plans per month, so no plan was generated for \`${headSha.slice(0, 7)}\`.`,
    `The limit resets on ${date} (UTC); comment \`@${slug} regenerate\` after that to get a plan.`,
  ]);
}
