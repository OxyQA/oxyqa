import assert from "node:assert/strict";
import test from "node:test";
import { createErrorReporter, createLlmObserver, observeLlmCall, type LlmCallRecord } from "../src/index.js";

test("observability is off and inert without configuration", async () => {
  const reporter = await createErrorReporter({ environment: "test" }, "worker");
  assert.equal(reporter.enabled, false);
  reporter.capture(new Error("ignored"), { prNumber: 1 });
  await reporter.shutdown();
  assert.equal(await createLlmObserver({ host: "https://cloud.langfuse.com" }), null);
  assert.equal(await createLlmObserver({ publicKey: "pk", host: "https://cloud.langfuse.com" }), null, "both keys are required");
});

test("LLM calls are recorded on success and failure without changing the result", async () => {
  const records: LlmCallRecord[] = [];
  const observer = { record: (r: LlmCallRecord) => { records.push(r); }, shutdown: async () => {} };
  const base = { name: "test-plan", model: "m", system: "s", prompt: "p", metadata: { prNumber: 7 } };
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  const ok = await observeLlmCall(observer, base, async () => ({ output: { summary: "x" }, usage }));
  assert.deepEqual(ok.output, { summary: "x" });
  assert.deepEqual(records[0]!.usage, usage);
  assert.equal(records[0]!.metadata!.prNumber, 7);
  assert.ok(records[0]!.endedAt >= records[0]!.startedAt);

  const boom = Object.assign(new Error("secret detail"), { name: "AI_APICallError" });
  await assert.rejects(observeLlmCall(observer, base, async () => { throw boom; }), boom);
  assert.equal(records[1]!.error, "AI_APICallError", "only the error class is traced, not its message");
  assert.equal(records[1]!.output, undefined);
});

test("a broken observer never breaks the model call, and no observer is fine", async () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const base = { name: "n", model: "m", system: "s", prompt: "p" };
  const broken = { record: () => { throw new Error("observer bug"); }, shutdown: async () => {} };
  assert.equal((await observeLlmCall(broken, base, async () => ({ output: 1, usage }))).output, 1);
  assert.equal((await observeLlmCall(null, base, async () => ({ output: 2, usage }))).output, 2);
});
