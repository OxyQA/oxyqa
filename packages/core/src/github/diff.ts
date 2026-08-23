// Turns GitHub's per-file patch data into a single prompt-ready diff string,
// with a character budget so a huge PR can't blow the model's context window,
// and skipPaths globs (from .oxyqa/config.yml) so teams can exclude noise
// (lockfiles, generated code) before it spends budget or distracts the model.

import picomatch from "picomatch";

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified-diff hunk for this file, as returned by the GitHub files endpoint. */
  patch?: string;
}

export interface FormatDiffOptions {
  /** Character budget for the assembled diff. */
  budget?: number;
  /** picomatch globs — matching files are excluded entirely (see RepoConfig.skipPaths). */
  skipPaths?: string[];
}

export interface FormattedDiff {
  text: string;
  /** Files whose patch made it into the text. */
  included: number;
  /** Files excluded by skipPaths globs. */
  skipped: number;
  /** Files dropped because the budget ran out. */
  omitted: number;
}

const DEFAULT_BUDGET = 24_000; // ~chars; roomy for Sonnet, well under context limits.

export function formatDiff(files: ChangedFile[], opts: FormatDiffOptions = {}): FormattedDiff {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const isSkipped = opts.skipPaths?.length
    ? picomatch(opts.skipPaths, { dot: true })
    : () => false;

  const blocks: string[] = [];
  let used = 0;
  let included = 0;
  let skipped = 0;
  let omitted = 0;

  // Changed code first (priority order matters once real windowing lands).
  for (const f of files) {
    if (isSkipped(f.filename)) {
      skipped++;
      continue;
    }
    const header = `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
    const body = f.patch ? `\n${f.patch}` : "\n(no textual diff — binary or too large)";
    const block = `${header}${body}`;

    if (used + block.length > budget) {
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length;
    included++;
  }

  if (skipped > 0) {
    blocks.push(`_[${skipped} file(s) excluded by the repo's skipPaths config]_`);
  }
  if (omitted > 0) {
    blocks.push(`_[${omitted} more file(s) omitted to stay within the context budget]_`);
  }
  return { text: blocks.join("\n\n"), included, skipped, omitted };
}
