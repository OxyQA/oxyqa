import assert from "node:assert/strict";
import test from "node:test";
import { processCommand, type CommandDependencies } from "../src/commands.js";
import type { CommandJob, PrJob } from "@oxyqa/core";

const base: CommandJob = { kind: "command", installationId: 1, owner: "org", repo: "repo", prNumber: 2, commentId: 3, actor: "alice", command: { type: "regenerate" } };
function fixture(overrides: Partial<CommandDependencies> = {}) {
  const effects: string[] = [];
  const jobs = new Map<string, PrJob>();
  const deps: CommandDependencies = {
    slug: "oxyqa-staging", canWrite: async () => true, isPullRequest: async () => true,
    remember: async () => { effects.push("remember"); }, forget: async () => { effects.push("forget"); return 1; },
    currentHead: async () => "current-sha", enqueue: async (job, id) => { if (!jobs.has(id)) jobs.set(id, job); },
    acknowledge: async (_, text) => { effects.push(text); }, ...overrides,
  };
  return { effects, jobs, deps };
}

test("unauthorized commands never mutate memories or regenerate", async () => {
  for (const command of [{ type: "remember", text: "x" }, { type: "forget", match: "x" }, { type: "focus", areas: "x" }, { type: "regenerate" }] as const) {
    const f = fixture({ canWrite: async () => false });
    assert.deepEqual(await processCommand({ ...base, command }, f.deps), { denied: true });
    assert.equal(f.jobs.size, 0);
    assert.equal(f.effects.length, 1);
    assert.match(f.effects[0]!, /write\/admin/);
  }
});

test("permission lookup failure propagates without side effects", async () => {
  const f = fixture({ canWrite: async () => { throw new Error("GitHub unavailable"); } });
  await assert.rejects(processCommand(base, f.deps), /GitHub unavailable/);
  assert.equal(f.jobs.size, 0); assert.deepEqual(f.effects, []);
});

test("regenerate retries use same ID, but a new comment can regenerate same head again", async () => {
  const f = fixture();
  await processCommand(base, f.deps); await processCommand(base, f.deps);
  assert.equal(f.jobs.size, 1);
  assert.equal([...f.jobs.values()][0]!.headSha, "current-sha");
  await processCommand({ ...base, commentId: 4 }, f.deps);
  assert.equal(f.jobs.size, 2);
});

test("focus is only in the requested job, never persisted or leaked to next regeneration", async () => {
  const f = fixture();
  await processCommand({ ...base, command: { type: "focus", areas: "accessibility" } }, f.deps);
  await processCommand({ ...base, commentId: 4 }, f.deps);
  const jobs = [...f.jobs.values()];
  assert.equal(jobs[0]!.oneShotFocus, "accessibility");
  assert.equal(jobs[1]!.oneShotFocus, undefined);
  assert.ok(!f.effects.includes("remember"));
});

test("non-PRs, closed PRs and help do not generate", async () => {
  const nonPr = fixture({ isPullRequest: async () => false });
  await processCommand(base, nonPr.deps); assert.deepEqual(nonPr.effects, []);
  const closed = fixture({ currentHead: async () => null });
  await processCommand(base, closed.deps); assert.equal(closed.jobs.size, 0);
  const help = fixture(); await processCommand({ ...base, command: { type: "help" } }, help.deps);
  assert.match(help.effects[0]!, /@oxyqa-staging remember/); assert.equal(help.jobs.size, 0);
});
