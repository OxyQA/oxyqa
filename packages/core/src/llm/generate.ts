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
  usage: { inputTokens: number; outputTokens: number };
}

export async function generateTestPlan(llm: LlmConfig, input: PromptInput): Promise<GenerateResult> {
  const model = resolveModel(llm);
  const { system, prompt } = buildTestPlanPrompt(input);

  const { object, usage } = await generateObject({
    model,
    schema: testPlanSchema,
    system,
    prompt,
  });

  return {
    plan: object,
    promptVersion: PROMPT_VERSION,
    usage: {
      inputTokens: usage.promptTokens ?? 0,
      outputTokens: usage.completionTokens ?? 0,
    },
  };
}
