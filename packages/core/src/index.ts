// @oxyqa/core — shared domain logic.
//
// Implemented (Phase 0/1):
//   - config      env-driven configuration (the cloud/self-hosted boundary)
//   - queue       shared PR job contract + BullMQ/Redis wiring
//   - github/diff format changed files into a budgeted, prompt-ready diff
//   - prompt      versioned prompt builder
//   - llm         provider-agnostic generateObject + Zod test-plan schema
//   - output      PR-comment renderer (update-in-place marker)
//
// Planned (Phase 2+):
//   - context/      .oxyqa/context.md, repo docs, linked tickets, windowing
//   - integrations/ Jira · Xray · Linear push
export * from "./config.js";
export * from "./queue.js";
export * from "./github/diff.js";
export * from "./prompt/build.js";
export * from "./llm/model.js";
export * from "./llm/schema.js";
export * from "./llm/generate.js";
export * from "./output/comment.js";
