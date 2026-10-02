// Provider-agnostic model resolution. The rest of the code asks for "the model"
// and never knows which vendor answered — this is what lets a self-hosted
// customer point at Azure/Bedrock/local by changing LLM_PROVIDER, no code change.
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

/** The LLM-only slice of config. Decoupled from the full app config so the LLM
 * step can run standalone with just an API key (see the sample script). */
export interface LlmConfig {
  provider: string;
  model: string;
  anthropicApiKey?: string;
}

export function resolveModel(llm: LlmConfig): LanguageModel {
  switch (llm.provider) {
    case "anthropic": {
      if (!llm.anthropicApiKey) {
        throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.");
      }
      return createAnthropic({ apiKey: llm.anthropicApiKey })(llm.model);
    }
    // Phase 4: openai / azure / bedrock / local slot in here, same interface.
    default:
      throw new Error(`LLM provider "${llm.provider}" is not wired yet.`);
  }
}
