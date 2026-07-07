// @oxyqa/worker — async processing (BullMQ consumer).
//
// Phase 1+ pipeline (all real work happens here, inside retryable jobs):
//   1. GitHub layer (Octokit) — fetch diff, files, hunks
//   2. Context enricher — .oxyqa/context.md · repo docs · linked tickets · windowing
//   3. Prompt builder — assemble + version the prompt
//   4. LLM orchestrator — Vercel AI SDK generateObject + Zod
//   5. Output formatter — PR comment / Check Run
//   6. Integration push — Jira · Xray · Linear
//   7. Feedback + metrics — record to DB, trace to Langfuse
//
// Jobs are idempotent (keyed on PR head SHA). Nothing implemented yet.
export {};
