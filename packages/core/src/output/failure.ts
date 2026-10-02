// Final-failure UX: a warning banner on the plan comment. Reasons are mapped to
// fixed, user-safe phrases — raw error messages can carry hosts, ids or stack
// detail and stay in worker logs only.
import { COMMENT_MARKER } from "./comment.js";

const FAILURE_START = "<!-- oxyqa:failure -->";
const FAILURE_END = "<!-- /oxyqa:failure -->";

interface ErrorShape { name?: string; status?: number; statusCode?: number; lastError?: unknown }

/** One-line, user-safe reason. Duck-typed so core needs no SDK error classes. */
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

export interface FailureMeta {
  reason: string;
  headSha: string;
  slug: string;
}

/**
 * Prepends the failure banner to the existing bot comment (or stands alone).
 * A previous plan stays visible below the banner; its footer names its commit.
 */
export function renderFailureComment(previous: string | null, { reason, headSha, slug }: FailureMeta): string {
  const rest = (previous ?? "")
    .replace(COMMENT_MARKER, "")
    .replace(new RegExp(`${FAILURE_START}[\\s\\S]*?${FAILURE_END}`), "")
    .trim();
  const banner = [
    FAILURE_START,
    "> [!WARNING]",
    `> OxyQA couldn't generate a test plan for \`${headSha.slice(0, 7)}\`: ${reason}.`,
    `> Comment \`@${slug} regenerate\` to retry.${rest ? " The plan below is from an earlier run." : ""}`,
    FAILURE_END,
  ].join("\n");
  return [COMMENT_MARKER, banner, ...(rest ? ["", rest] : [])].join("\n");
}
