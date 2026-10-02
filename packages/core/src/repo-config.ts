// `.oxyqa/config.yml` behavior knobs (DECISIONS.md §3): per-repo tuning of how
// plans are generated and rendered. Prose knowledge stays in `.oxyqa/context.md`
// (context/repo.ts); this file is for machine-readable settings only.
//
// Merge order: built-in defaults ← repo config.yml ← per-install overrides
// (`installations.config` JSONB) — later layers win, field by field.
//
// Resilience rule: bad config must never fail a plan. YAML is parsed as plain
// data (no tags, no code paths), each field is validated independently, and an
// invalid value falls back to the layer below it with a warning the worker logs.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MONTHLY_PLAN_LIMIT_KEY } from "./limits.js";

export const REPO_CONFIG_PATH = ".oxyqa/config.yml";

/** Hard ceiling — must not exceed testPlanSchema's `.max()` on testCases. */
export const MAX_CASES_CEILING = 15;

/** Anything bigger than this is not a config file; skip the layer entirely. */
const MAX_CONFIG_BYTES = 32_000;

export interface RepoConfig {
  /** Upper bound on generated test cases (1–15). */
  maxCases: number;
  /** Areas the team wants plans to emphasize, e.g. "auth flows", "mobile Safari". */
  focusAreas: string[];
  /** Glob patterns (picomatch syntax) for changed files to exclude from the diff.
   * Directories need an explicit glob: `docs/**`, not `docs/`. */
  skipPaths: string[];
  /** PR-comment layout: "flat" = one numbered list (the original layout);
   * "grouped" = cases grouped under priority headings. */
  commentStyle: "grouped" | "flat";
}

/** "flat" default keeps the shipped comment layout stable for existing installs. */
export const DEFAULT_REPO_CONFIG: RepoConfig = {
  maxCases: 10,
  focusAreas: [],
  skipPaths: [],
  commentStyle: "flat",
};

// Per-field validators — validated independently so one bad knob doesn't
// discard the rest of its layer.
const FIELD_SCHEMAS = {
  maxCases: z.number().int().min(1).max(MAX_CASES_CEILING),
  focusAreas: z.array(z.string().trim().min(1)).max(10),
  skipPaths: z.array(z.string().trim().min(1)).max(50),
  commentStyle: z.enum(["grouped", "flat"]),
} as const satisfies Record<keyof RepoConfig, z.ZodTypeAny>;

const KNOWN_KEYS = Object.keys(FIELD_SCHEMAS) as (keyof RepoConfig)[];

/** Install-level settings read elsewhere; valid in the install layer only. */
const INSTALL_ONLY_KEYS: string[] = [MONTHLY_PLAN_LIMIT_KEY];

export interface ResolvedRepoConfig {
  config: RepoConfig;
  /** Layers that contributed at least one valid field, for the worker log. */
  sources: ("defaults" | "repo-yml" | "install")[];
  /** Human-readable problems (parse failures, invalid/unknown fields). */
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlay one raw layer onto `base`, keeping only fields that validate. */
function applyLayer(
  base: RepoConfig,
  raw: Record<string, unknown>,
  layer: string,
  warnings: string[],
  alsoAllowed: string[] = [],
): { config: RepoConfig; contributed: boolean } {
  const config = { ...base };
  let contributed = false;

  for (const key of Object.keys(raw)) {
    if (!(KNOWN_KEYS as string[]).includes(key) && !alsoAllowed.includes(key)) {
      warnings.push(`${layer}: unknown key "${key}" ignored (known: ${KNOWN_KEYS.join(", ")})`);
    }
  }
  for (const key of KNOWN_KEYS) {
    if (!(key in raw) || raw[key] === undefined || raw[key] === null) continue;
    const parsed = FIELD_SCHEMAS[key].safeParse(raw[key]);
    if (parsed.success) {
      // Cast is safe: each field schema outputs exactly its RepoConfig type.
      (config as Record<string, unknown>)[key] = parsed.data;
      contributed = true;
    } else {
      warnings.push(`${layer}: invalid "${key}" ignored — ${parsed.error.issues[0]?.message}`);
    }
  }
  return { config, contributed };
}

/** Parse the repo's config.yml into a raw layer. Never throws. */
function parseRepoYaml(text: string, warnings: string[]): Record<string, unknown> | null {
  if (text.length > MAX_CONFIG_BYTES) {
    warnings.push(`${REPO_CONFIG_PATH}: file exceeds ${MAX_CONFIG_BYTES} bytes — ignored`);
    return null;
  }
  let parsed: unknown;
  try {
    // "core" schema = plain YAML data only (scalars/maps/lists, no custom tags).
    parsed = parseYaml(text, { schema: "core" });
  } catch (err) {
    warnings.push(`${REPO_CONFIG_PATH}: YAML parse error — ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
  if (parsed === null || parsed === undefined) return null; // empty file — fine
  if (!isPlainObject(parsed)) {
    warnings.push(`${REPO_CONFIG_PATH}: expected a top-level mapping — ignored`);
    return null;
  }
  return parsed;
}

export function resolveRepoConfig(input: {
  /** Raw `.oxyqa/config.yml` contents from the target repo, if the file exists. */
  repoYaml?: string | null;
  /** Per-install overrides from `installations.config` (same knob keys, flat). */
  installOverrides?: Record<string, unknown> | null;
}): ResolvedRepoConfig {
  const warnings: string[] = [];
  const sources: ResolvedRepoConfig["sources"] = ["defaults"];
  let config = { ...DEFAULT_REPO_CONFIG };

  if (input.repoYaml?.trim()) {
    const raw = parseRepoYaml(input.repoYaml, warnings);
    if (raw) {
      const applied = applyLayer(config, raw, REPO_CONFIG_PATH, warnings);
      config = applied.config;
      if (applied.contributed) sources.push("repo-yml");
    }
  }

  if (input.installOverrides && isPlainObject(input.installOverrides)) {
    const applied = applyLayer(config, input.installOverrides, "install config", warnings, INSTALL_ONLY_KEYS);
    config = applied.config;
    if (applied.contributed) sources.push("install");
  }

  return { config, sources, warnings };
}
