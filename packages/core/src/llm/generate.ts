// The LLM orchestrator: prompt in, validated TestPlan out. This is the single
// place that calls the model, so cost/latency instrumentation (Langfuse) and
// retries have one home.
import { generateObject } from "ai";
import { PROMPT_VERSION, buildTestPlanPrompt, type PromptInput } from "../prompt/build.js";
import { type LlmConfig, resolveModel } from "./model.js";
import { type TestCase, type TestPlan, testPlanSchema } from "./schema.js";

const PRIORITY_RANK: Record<TestCase["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Backstop for RepoConfig.maxCases: the prompt asks for at most N, but if the
 * model overshoots, keep the N highest-priority cases (preserving the model's
 * original ordering among the kept ones). */
function enforceMaxCases(plan: TestPlan, maxCases: number): TestPlan {
  if (plan.testCases.length <= maxCases) return plan;
  const keep = new Set(
    plan.testCases
      .map((tc, i) => ({ i, rank: PRIORITY_RANK[tc.priority] }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .slice(0, maxCases)
      .map((e) => e.i),
  );
  return { ...plan, testCases: plan.testCases.filter((_, i) => keep.has(i)) };
}

export interface GenerateResult {
  plan: TestPlan;
  promptVersion: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic prompt-cache metrics (0 on other providers). If cacheRead stays
     * 0 across re-runs on the same repo, the prefix is being invalidated — or is
     * under the ~1024-token minimum cacheable size. */
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export async function generateTestPlan(llm: LlmConfig, input: PromptInput): Promise<GenerateResult> {
  const model = resolveModel(llm);
  const { system, prompt } = buildTestPlanPrompt(input);

  const { object, usage, providerMetadata } = await generateObject({
    model,
    schema: testPlanSchema,
    messages: [
      {
        role: "system",
        content: system,
        // Cache breakpoint: everything up to here ([tools +] system + repo
        // context) is stable per-repo; the per-PR prompt below varies freely.
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { role: "user", content: prompt },
    ],
  });

  const cache = providerMetadata?.anthropic as
    | { cacheReadInputTokens?: number | null; cacheCreationInputTokens?: number | null }
    | undefined;

  return {
    plan: input.behavior ? enforceMaxCases(object, input.behavior.maxCases) : object,
    promptVersion: PROMPT_VERSION,
    usage: {
      inputTokens: usage.promptTokens ?? 0,
      outputTokens: usage.completionTokens ?? 0,
      cacheReadInputTokens: cache?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: cache?.cacheCreationInputTokens ?? 0,
    },
  };
}
