// Turns GitHub's per-file patch data into a single prompt-ready diff string,
// with a character budget so a huge PR can't blow the model's context window.
// This is the lightweight seed of Phase 2's real context-windowing.

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified-diff hunk for this file, as returned by the GitHub files endpoint. */
  patch?: string;
}

const DEFAULT_BUDGET = 24_000; // ~chars; roomy for Sonnet, well under context limits.

export function formatDiff(files: ChangedFile[], budget = DEFAULT_BUDGET): string {
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;

  // Changed code first (priority order matters once real windowing lands).
  for (const f of files) {
    const header = `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
    const body = f.patch ? `\n${f.patch}` : "\n(no textual diff — binary or too large)";
    const block = `${header}${body}`;

    if (used + block.length > budget) {
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }

  if (omitted > 0) {
    blocks.push(`_[${omitted} more file(s) omitted to stay within the context budget]_`);
  }
  return blocks.join("\n\n");
}
