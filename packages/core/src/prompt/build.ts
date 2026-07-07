// Assembles the diff (and, later, enriched context) into a structured prompt.
// PROMPT_VERSION is stored with every plan so quality changes are attributable
// to a specific template (Phase 2: prompt versioning).

export const PROMPT_VERSION = "v1";

export interface PromptInput {
  prTitle: string;
  prBody?: string;
  /** Pre-formatted diff (see github/diff.ts). */
  diff: string;
  /** Committed team knowledge from .oxyqa/context.md + learned memory (Phase 2). */
  context?: string;
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
  const parts: string[] = [];
  parts.push(`PR title: ${input.prTitle}`);
  if (input.prBody?.trim()) {
    parts.push(`PR description:\n${input.prBody.trim()}`);
  }
  if (input.context?.trim()) {
    parts.push(`Team context and conventions (always honor these):\n${input.context.trim()}`);
  }
  parts.push(`Code diff:\n${input.diff}`);
  parts.push(`Write the QA test plan for the changes above.`);

  return { system: SYSTEM, prompt: parts.join("\n\n") };
}
