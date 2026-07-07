// @oxyqa/core — shared domain logic.
//
// Implemented (Phase 0/1):
//   - config    env-driven configuration (the cloud/self-hosted boundary)
//   - queue     shared PR job contract + BullMQ/Redis wiring
//
// Planned (Phase 1+):
//   - github/       Octokit app auth + diff fetch/parse
//   - context/      .oxyqa/context.md, repo docs, linked tickets, windowing
//   - prompt/       prompt builder + versioning
//   - llm/          provider-agnostic generateObject + Zod test-case schema
//   - output/       PR comment / Check Run formatting
//   - integrations/ Jira · Xray · Linear push
export * from "./config.js";
export * from "./queue.js";
