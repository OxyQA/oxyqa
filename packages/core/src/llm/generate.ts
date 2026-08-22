// The LLM orchestrator: prompt in, validated TestPlan out. This is the single
// place that calls the model, so cost/latency instrumentation (Langfuse) and
// retries have one home.
import { generateObject } from "ai";
import { PROMPT_VERSION, buildTestPlanPrompt, type PromptInput } from "../prompt/build.js";
import { type LlmConfig, resolveModel } from "./model.js";
import { type TestPlan, testPlanSchema } from "./schema.js";

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
    plan: object,
    promptVersion: PROMPT_VERSION,
    usage: {
      inputTokens: usage.promptTokens ?? 0,
      outputTokens: usage.completionTokens ?? 0,
      cacheReadInputTokens: cache?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: cache?.cacheCreationInputTokens ?? 0,
    },
  };
}
