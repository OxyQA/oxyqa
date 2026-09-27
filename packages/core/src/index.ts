// @oxyqa/core — shared domain logic.
//
// Implemented (Phase 0/1):
//   - config      env-driven configuration (the cloud/self-hosted boundary)
//   - queue       shared PR job contract + BullMQ/Redis wiring
//   - github/diff format changed files into a budgeted, prompt-ready diff
//   - prompt      versioned prompt builder (cached stable prefix + volatile tail)
//   - llm         provider-agnostic generateObject + Zod test-plan schema
//   - output      PR-comment renderer (update-in-place marker)
//   - context     Phase 2: .oxyqa/context.md / README and repo memories, budgeted
//   - commands    explicit reply-to-agent command parsing
//   - repo-config Phase 2: .oxyqa/config.yml behavior knobs (defaults ← yml ← install)
//
// Planned (Phase 2+):
//   - context/      linked tickets
//   - integrations/ Linear push (Jira/Xray deferred)
export * from "./config.js";
export * from "./repo-config.js";
export * from "./queue.js";
export * from "./commands.js";
export * from "./context/memories.js";
export * from "./context/repo.js";
export * from "./github/diff.js";
export * from "./prompt/build.js";
export * from "./llm/model.js";
export * from "./llm/schema.js";
export * from "./llm/generate.js";
export * from "./output/comment.js";
