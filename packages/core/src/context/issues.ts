// Phase 2 context source 3 (DECISIONS.md §3): GitHub issues linked from a PR.
// The issue usually states the requirement the diff implements, so it tells
// the model what "correct" means. References are parsed from the PR title,
// body and branch name; only same-repo issues are fetched (the installation
// token is guaranteed to reach those).
//
// Linked issues are per-PR, so they go in the volatile prompt tail — never in
// the cached system prefix (see prompt/build.ts).
import { estimateTokens } from "./repo.js";

export const MAX_LINKED_ISSUES = 3;
export const LINKED_ISSUE_TOKEN_BUDGET = 600;

export interface IssueRefSource {
  title: string;
  body?: string | null;
  branch?: string | null;
}

export interface LinkedIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
}

const CLOSING = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;

function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * Issue numbers referenced by a PR, most relevant first: closing keywords
 * ("Fixes #12"), then other mentions in title/body, then the branch name
 * (`12-add-login`, `issue-12`, `feat/12-add-login`). Cross-repo references
 * and anything inside code spans are ignored.
 */
export function extractIssueRefs(source: IssueRefSource, repo: { owner: string; repo: string }, selfNumber?: number): number[] {
  const text = stripCode(`${source.title}\n${source.body ?? ""}`);
  const slug = `${repo.owner}/${repo.repo}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `#12`, `owner/repo#12` (this repo only) or a full issue URL for this repo.
  const ref = String.raw`(?:(?<![\w/#-])(?:${slug})?#(\d{1,7})\b|https?://github\.com/${slug}/issues/(\d{1,7})\b)`;
  const ordered: number[] = [];
  const add = (n: string | undefined) => {
    const num = Number(n);
    if (n && num > 0 && num !== selfNumber && !ordered.includes(num)) ordered.push(num);
  };
  for (const m of text.matchAll(new RegExp(String.raw`\b${CLOSING}:?\s+${ref}`, "gi"))) add(m[1] ?? m[2]);
  for (const m of text.matchAll(new RegExp(ref, "gi"))) add(m[1] ?? m[2]);
  const branch = source.branch ?? "";
  add(/(?:^|\/)(?:issues?[-_/])?(\d{1,7})[-_]/i.exec(branch)?.[1] ?? /(?:^|[-_/])issues?[-_/](\d{1,7})$/i.exec(branch)?.[1]);
  return ordered.slice(0, MAX_LINKED_ISSUES);
}

/** Prompt-ready block, each issue clipped to its own budget. */
export function formatLinkedIssues(issues: readonly LinkedIssue[]): string | undefined {
  if (!issues.length) return undefined;
  return issues.map((issue) => {
    const labels = issue.labels.length ? ` [${issue.labels.slice(0, 5).join(", ")}]` : "";
    let body = (issue.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim() || "(no description)";
    if (estimateTokens(body) > LINKED_ISSUE_TOKEN_BUDGET) body = `${body.slice(0, LINKED_ISSUE_TOKEN_BUDGET * 4)}\n[issue truncated]`;
    return `### #${issue.number}: ${issue.title} (${issue.state})${labels}\n${body}`;
  }).join("\n\n");
}
