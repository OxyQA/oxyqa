// @oxyqa/core — shared domain logic.
//
// Implemented (Phase 0/1):
//   - config      env-driven configuration (the cloud/self-hosted boundary)
//   - queue       shared PR job contract + BullMQ/Redis wiring
//   - github/diff format changed files into a budgeted, prompt-ready diff
//   - prompt      versioned prompt builder (cached stable prefix + volatile tail)
//   - llm         provider-agnostic generateObject + Zod test-plan schema
//   - output      PR-comment renderer (update-in-place marker) + final-failure banner
//   - context     Phase 2: .oxyqa/context.md / README, repo memories and linked issues, budgeted
//   - commands    reply-to-agent: keyword commands + natural-language routing (llm/route)
//   - limits      free-tier gating: per-install monthly plan cap
//   - observability optional Sentry error reporting + Langfuse LLM tracing
//   - repo-config Phase 2: .oxyqa/config.yml behavior knobs (defaults ← yml ← install)
//
// Planned (Phase 2+):
//   - context/      Linear tickets
//   - integrations/ Linear push (Jira/Xray deferred); GitHub tracking issue is in output/issue
export * from "./config.js";
export * from "./repo-config.js";
export * from "./limits.js";
export * from "./queue.js";
export * from "./commands.js";
export * from "./context/memories.js";
export * from "./context/repo.js";
export * from "./context/issues.js";
export * from "./github/diff.js";
export * from "./prompt/build.js";
export * from "./llm/model.js";
export * from "./llm/schema.js";
export * from "./llm/generate.js";
export * from "./llm/route.js";
export * from "./output/comment.js";
export * from "./output/failure.js";
export * from "./observability.js";
export * from "./output/issue.js";
