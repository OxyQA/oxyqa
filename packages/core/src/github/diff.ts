// Turns GitHub's per-file patch data into a single prompt-ready diff string
// under a character budget, so a huge PR can't blow the context window or the
// per-plan cost. Three rules decide what the model sees on a large PR:
//
//   1. skipPaths globs (.oxyqa/config.yml) exclude files entirely.
//   2. Files are ranked by how much they tell a tester: source first, then
//      tests, then docs/config, then generated noise (lockfiles, snapshots,
//      build output). GitHub's alphabetical order only breaks ties.
//   3. A file that doesn't fit is truncated, not dropped, and files with no
//      room at all are still listed by name — the model always knows the full
//      shape of the change.

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
  /** Files whose patch made it into the text, whole or truncated. */
  included: number;
  /** Of `included`, files whose patch was cut to fit. */
  truncated: number;
  /** Files excluded by skipPaths globs. */
  skipped: number;
  /** Files listed by name only because the budget ran out. */
  omitted: number;
}

/** ~15k tokens. Raised from 24k chars on 2026-10-02 (DECISIONS.md §3): on real
 * multi-file PRs the old budget dropped most of the change. */
export const DEFAULT_DIFF_BUDGET = 60_000;
/** No single file may take more than this share of the budget. */
const MAX_FILE_SHARE = 0.4;
/** Below this much room a truncated patch is not worth including. */
const MIN_USEFUL_PATCH = 600;
const MAX_LISTED_OMITTED = 40;

const NOISE = picomatch([
  "**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/go.sum", "**/Cargo.lock",
  "**/*.min.*", "**/*.map", "**/*.snap", "**/__snapshots__/**", "**/dist/**", "**/build/**", "**/vendor/**",
  "**/node_modules/**", "**/*.generated.*", "**/migrations/meta/**", "**/*.svg",
], { dot: true });
const TESTS = picomatch([
  "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py", "**/__tests__/**", "**/test/**", "**/tests/**",
  "**/spec/**", "**/e2e/**", "**/cypress/**", "**/fixtures/**",
], { dot: true });
const DOCS_CONFIG = picomatch([
  "**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "**/*.json", "**/*.yml", "**/*.yaml", "**/*.toml", "**/*.ini",
  "**/.*", "**/.github/**", "**/docs/**", "**/LICENSE*",
], { dot: true });

/** 0 = source (most useful to a tester) … 3 = generated noise. */
export function fileTier(filename: string): 0 | 1 | 2 | 3 {
  if (NOISE(filename)) return 3;
  if (TESTS(filename)) return 1;
  if (DOCS_CONFIG(filename)) return 2;
  return 0;
}

function truncatePatch(patch: string, room: number): string {
  const cut = patch.slice(0, room);
  const lastLine = cut.lastIndexOf("\n");
  return `${lastLine > 0 ? cut.slice(0, lastLine) : cut}\n[… patch truncated to fit the context budget]`;
}

export function formatDiff(files: ChangedFile[], opts: FormatDiffOptions = {}): FormattedDiff {
  const budget = opts.budget ?? DEFAULT_DIFF_BUDGET;
  const isSkipped = opts.skipPaths?.length
    ? picomatch(opts.skipPaths, { dot: true })
    : () => false;

  const candidates = files.filter((f) => !isSkipped(f.filename));
  const skipped = files.length - candidates.length;
  const ranked = candidates
    .map((f, i) => ({ f, i, tier: fileTier(f.filename) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i);

  const fileCap = Math.floor(budget * MAX_FILE_SHARE);
  const blocks: string[] = [];
  const omittedFiles: ChangedFile[] = [];
  let used = 0;
  let included = 0;
  let truncated = 0;

  for (const { f } of ranked) {
    const header = `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
    if (!f.patch) {
      const block = `${header}\n(no textual diff — binary or too large)`;
      if (used + block.length > budget) { omittedFiles.push(f); continue; }
      blocks.push(block); used += block.length; included++;
      continue;
    }
    const room = Math.min(fileCap, budget - used - header.length - 1);
    if (f.patch.length <= room) {
      blocks.push(`${header}\n${f.patch}`);
      used += header.length + 1 + f.patch.length;
      included++;
    } else if (room >= MIN_USEFUL_PATCH) {
      const patch = truncatePatch(f.patch, room);
      blocks.push(`${header}\n${patch}`);
      used += header.length + 1 + patch.length;
      included++;
      truncated++;
    } else {
      omittedFiles.push(f);
    }
  }

  if (omittedFiles.length > 0) {
    const listed = omittedFiles.slice(0, MAX_LISTED_OMITTED).map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`);
    const more = omittedFiles.length - listed.length;
    blocks.push(`### Also changed — diff not shown (context budget)\n${listed.join("\n")}${more > 0 ? `\n- …and ${more} more` : ""}`);
  }
  if (skipped > 0) {
    blocks.push(`_[${skipped} file(s) excluded by the repo's skipPaths config]_`);
  }
  return { text: blocks.join("\n\n"), included, truncated, skipped, omitted: omittedFiles.length };
}
