// The LLM orchestrator: prompt in, validated TestPlan out (provider-native
// structured output; no sampling parameters are sent, so current models accept it). This is the single
// place that calls the model, so cost/latency instrumentation (Langfuse) and
// retries have one home.
import { Output, generateText } from "ai";
import { PROMPT_VERSION, buildTestPlanPrompt, type PromptInput } from "../prompt/build.js";
import { type LlmObserver, observeLlmCall } from "../observability.js";
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

export interface GenerateOptions {
  /** Optional LLM tracing sink (Langfuse); see observability.ts. */
  observer?: LlmObserver | null;
  /** Trace metadata — ids only (installation, repo, PR, head SHA). */
  metadata?: Record<string, string | number | undefined>;
}

export async function generateTestPlan(llm: LlmConfig, input: PromptInput, options: GenerateOptions = {}): Promise<GenerateResult> {
  const model = resolveModel(llm);
  const { system, prompt } = buildTestPlanPrompt(input);

  const { output, usage } = await observeLlmCall(
    options.observer,
    { name: "test-plan", model: llm.model, system, prompt, metadata: { ...options.metadata, promptVersion: PROMPT_VERSION } },
    async () => {
      const { output: object, usage, providerMetadata } = await generateText({
        model,
        output: Output.object({ schema: testPlanSchema }),
        // Cache breakpoint: everything up to here ([tools +] system + repo
        // context) is stable per-repo; the per-PR prompt below varies freely.
        instructions: {
          role: "system",
          content: system,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        prompt,
      });
      const cache = providerMetadata?.anthropic as
        | { cacheReadInputTokens?: number | null; cacheCreationInputTokens?: number | null }
        | undefined;
      return {
        output: object,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? cache?.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: usage.inputTokenDetails?.cacheWriteTokens ?? cache?.cacheCreationInputTokens ?? 0,
        },
      };
    },
  );

  return {
    plan: input.behavior ? enforceMaxCases(output, input.behavior.maxCases) : output,
    promptVersion: PROMPT_VERSION,
    usage,
  };
}
