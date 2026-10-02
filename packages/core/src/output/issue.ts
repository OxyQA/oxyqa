// Phase 3a (DECISIONS.md §6): the plan as ONE GitHub tracking issue with a
// tickable checklist — never one issue per case. Case numbers match the PR
// comment (see numberCases).
import { type CommentStyle, numberCases, priorityLabel } from "./comment.js";

export const TRACKING_ISSUE_MARKER = "<!-- oxyqa:tracking-issue -->";

export interface TrackingIssueCase {
  title: string;
  description: string | null;
  steps: string[];
  expected: string | null;
  priority: string;
}

export interface TrackingIssueInput {
  prNumber: number;
  prTitle: string;
  headSha: string;
  summary: string | null;
  cases: readonly TrackingIssueCase[];
  style: CommentStyle;
}

export function renderTrackingIssue(input: TrackingIssueInput): { title: string; body: string } {
  const lines = [
    TRACKING_ISSUE_MARKER,
    `QA checklist for #${input.prNumber} at \`${input.headSha.slice(0, 7)}\`. Tick each case off as you run it.`,
    "",
  ];
  if (input.summary?.trim()) lines.push(`> ${input.summary.trim().replace(/\n+/g, " ")}`, "");
  for (const { num, tc } of numberCases(input.cases, input.style)) {
    lines.push(`- [ ] **${num}. ${tc.title}** · ${priorityLabel(tc.priority)}`);
    lines.push("  <details><summary>Steps and expected result</summary>", "");
    if (tc.description?.trim()) lines.push(`  ${tc.description.trim().replace(/\n/g, "\n  ")}`, "");
    tc.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.replace(/\n/g, " ")}`));
    if (tc.expected?.trim()) lines.push("", `  **Expected:** ${tc.expected.trim().replace(/\n/g, "\n  ")}`);
    lines.push("", "  </details>");
  }
  lines.push("", "---", "<sub>Created by OxyQA from the test plan on the pull request. Re-running the command updates this issue and resets the checkboxes.</sub>");
  // GitHub caps issue titles at 256 characters.
  const title = `QA: ${input.prTitle}`.slice(0, 240) + ` (#${input.prNumber})`;
  return { title, body: lines.join("\n") };
}
