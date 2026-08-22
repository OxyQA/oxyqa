// Assembles the diff and enriched repo context into a structured prompt.
// PROMPT_VERSION is stored with every plan so quality changes are attributable
// to a specific template.
//
// Cache-driven layout (DECISIONS.md §3): everything stable per-repo — the
// system instructions and repo context — lives in `system`, which generate.ts
// marks as an Anthropic cache breakpoint. Volatile per-PR content (title, body,
// diff) goes in `prompt`, after the breakpoint. Don't move repo context into
// the prompt: any byte before the breakpoint that varies per-PR kills caching.

export const PROMPT_VERSION = "v2";

export interface PromptInput {
  prTitle: string;
  prBody?: string;
  /** Pre-formatted diff (see github/diff.ts). */
  diff: string;
  /** Repo-level context: .oxyqa/context.md or README excerpt (see context/repo.ts).
   * Stable per-repo — becomes part of the cached prompt prefix. */
  repoContext?: string;
}

const SYSTEM = `You are a senior QA engineer writing a focused test plan for a pull request.
You are given the PR's title, description, and code diff. Produce test cases that
verify the *changed behavior* — not the whole application.

Rules:
- Prioritize the changed code paths and their edge cases over generic happy-path checks.
- Each test case must be concrete and independently runnable by a human tester.
- Prefer a small number of high-value cases over an exhaustive list.
- Call out security- or data-integrity-sensitive changes with higher priority.
- If the diff is trivial (docs, formatting), say so in the summary and keep the plan minimal.`;

export function buildTestPlanPrompt(input: PromptInput): { system: string; prompt: string } {
  let system = SYSTEM;
  if (input.repoContext?.trim()) {
    system += `\n\n## Repository context\n\nTeam-provided knowledge about this repository — domain terms, testing conventions, and constraints. Always honor these when writing test cases:\n\n${input.repoContext.trim()}`;
  }

  const parts: string[] = [];
  parts.push(`PR title: ${input.prTitle}`);
  if (input.prBody?.trim()) {
    parts.push(`PR description:\n${input.prBody.trim()}`);
  }
  parts.push(`Code diff:\n${input.diff}`);
  parts.push(`Write the QA test plan for the changes above.`);

  return { system, prompt: parts.join("\n\n") };
}
