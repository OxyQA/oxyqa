// Phase 2 context enrichment: pull repo-level knowledge into the prompt.
//
// Priority order (DECISIONS.md §3): `.oxyqa/context.md` (team-authored domain
// terms + testing conventions) wins; the repo README is the fallback
// orientation when no context file exists. Each source has its own token
// budget; truncation is visible in the prompt so teams know to trim the file.
//
// Repo context is stable per-repo across PR runs, which is what makes it part
// of the cacheable prompt prefix (see prompt/build.ts + llm/generate.ts).

export const CONTEXT_FILE_PATH = ".oxyqa/context.md";
export const CONTEXT_FILE_TOKEN_BUDGET = 6_000;
export const README_TOKEN_BUDGET = 1_500;

/** Minimal read surface the worker adapts its Octokit onto — core stays free of
 * GitHub client dependencies (same pattern as github/diff.ts's ChangedFile). */
export interface RepoContentReader {
  /** Decoded UTF-8 content of `path` at `ref`, or null if the file doesn't exist. */
  readFile(path: string, ref: string): Promise<string | null>;
  /** Decoded content of the repo's README, or null if there isn't one. */
  readReadme(ref: string): Promise<string | null>;
}

export interface RepoContext {
  /** Prompt-ready context block, or undefined when the repo has neither source. */
  text: string | undefined;
  source: "context-file" | "readme" | "none";
  truncated: boolean;
}

/** Rough chars/4 heuristic — budgets here are soft caps, not billing math. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(
  text: string,
  budget: number,
  label: string,
): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= budget) return { text, truncated: false };
  const clipped = text.slice(0, budget * 4);
  return {
    text: `${clipped}\n\n[${label} truncated here — ~${budget}-token budget reached. Trim the file to keep everything visible.]`,
    truncated: true,
  };
}

export async function loadRepoContext(reader: RepoContentReader, ref: string): Promise<RepoContext> {
  const contextFile = await reader.readFile(CONTEXT_FILE_PATH, ref);
  if (contextFile?.trim()) {
    const { text, truncated } = truncateToTokenBudget(
      contextFile.trim(),
      CONTEXT_FILE_TOKEN_BUDGET,
      CONTEXT_FILE_PATH,
    );
    return { text, source: "context-file", truncated };
  }

  const readme = await reader.readReadme(ref);
  if (readme?.trim()) {
    const { text, truncated } = truncateToTokenBudget(readme.trim(), README_TOKEN_BUDGET, "README");
    return { text, source: "readme", truncated };
  }

  return { text: undefined, source: "none", truncated: false };
}
