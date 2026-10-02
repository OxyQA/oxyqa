import assert from "node:assert/strict";
import test from "node:test";
import { processCommand, runCommand, type CommandDependencies } from "../src/commands.js";
import type { CommandJob, PrJob } from "@oxyqa/core";

const base: CommandJob = { kind: "command", installationId: 1, owner: "org", repo: "repo", prNumber: 2, commentId: 3, actor: "alice", command: { type: "regenerate" } };
function fixture(overrides: Partial<CommandDependencies> = {}) {
  const effects: string[] = [];
  const jobs = new Map<string, PrJob>();
  const deps: CommandDependencies = {
    slug: "oxyqa-staging", canWrite: async () => true, isPullRequest: async () => true,
    remember: async (_, text) => { effects.push(`remember:${text}`); }, forget: async () => { effects.push("forget"); return 1; },
    createIssue: async () => ({ status: "created", number: 12, url: "https://github.com/org/repo/issues/12" }),
    interpret: async () => ({ type: "help" }), forgetIds: async (_, ids) => { effects.push(`forgetIds:${ids.join(",")}`); return ids.length; },
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
  assert.ok(!f.effects.some((e) => e.startsWith("remember")));
});

test("non-PRs, closed PRs and help do not generate", async () => {
  const nonPr = fixture({ isPullRequest: async () => false });
  await processCommand(base, nonPr.deps); assert.deepEqual(nonPr.effects, []);
  const closed = fixture({ currentHead: async () => null });
  await processCommand(base, closed.deps); assert.equal(closed.jobs.size, 0);
  const help = fixture(); await processCommand({ ...base, command: { type: "help" } }, help.deps);
  assert.match(help.effects[0]!, /@oxyqa-staging remember/); assert.equal(help.jobs.size, 0);
});

test("freeform comments are routed after the permission check and echo their interpretation", async () => {
  const freeform = { ...base, command: { type: "freeform", text: "from now on check Safari on checkout" } } as const;
  let interpreted = 0;
  const denied = fixture({ canWrite: async () => false, interpret: async () => { interpreted++; return { type: "regenerate" }; } });
  assert.deepEqual(await processCommand(freeform, denied.deps), { denied: true });
  assert.equal(interpreted, 0, "no model call for unauthorized commenters");

  const remember = fixture({ interpret: async () => ({ type: "remember", text: "Always test checkout in Safari." }) });
  assert.deepEqual(await processCommand(freeform, remember.deps), { command: "freeform", interpreted: "remember" });
  assert.equal(remember.effects[0], "remember:Always test checkout in Safari.");
  assert.match(remember.effects[1]!, /Saved repository guidance:\n\n> Always test checkout in Safari\./);

  const focus = fixture({ interpret: async () => ({ type: "focus", areas: "keyboard access" }) });
  await processCommand(freeform, focus.deps);
  assert.equal([...focus.jobs.values()][0]!.oneShotFocus, "keyboard access");
  assert.match(focus.effects[0]!, /one-time focus on:\n\n> keyboard access/);

  const regenerate = fixture({ interpret: async () => ({ type: "regenerate" }) });
  await processCommand(freeform, regenerate.deps);
  assert.equal(regenerate.jobs.size, 1);
  assert.equal([...regenerate.jobs.values()][0]!.oneShotFocus, undefined);
});

test("routed forget names what it removed; no match and unclear intent change nothing", async () => {
  const freeform = { ...base, command: { type: "freeform", text: "drop the safari rule" } } as const;
  const forget = fixture({ interpret: async () => ({ type: "forget", memories: [{ id: "m1", content: "Always test Safari" }] }) });
  await processCommand(freeform, forget.deps);
  assert.deepEqual(forget.effects.slice(0, 1), ["forgetIds:m1"]);
  assert.match(forget.effects[1]!, /Forgot this repository memory:\n\n- Always test Safari/);

  const none = fixture({ interpret: async () => ({ type: "forget", memories: [] }) });
  await processCommand(freeform, none.deps);
  assert.match(none.effects.at(-1)!, /nothing was removed/);

  const unclear = fixture();
  assert.deepEqual(await processCommand(freeform, unclear.deps), { command: "freeform", interpreted: "help" });
  assert.match(unclear.effects[0]!, /not sure what to do[\s\S]*@oxyqa-staging remember/);
  assert.equal(unclear.jobs.size, 0);
});

test("a router outage degrades to help without retrying or side effects", async () => {
  const f = fixture({ interpret: async () => { throw new Error("model down"); } });
  const freeform = { ...base, command: { type: "freeform", text: "please regenerate" } } as const;
  assert.deepEqual(await processCommand(freeform, f.deps), { command: "freeform", interpreted: "error" });
  assert.match(f.effects[0]!, /couldn't interpret that just now[\s\S]*exact commands still work/);
  assert.equal(f.jobs.size, 0);
});

test("create issue reports each outcome and is reachable by keyword and by routing", async () => {
  const keyword = { ...base, command: { type: "create-issue" } } as const;
  const created = fixture(); await processCommand(keyword, created.deps);
  assert.match(created.effects[0]!, /Opened #12 with this plan as a checklist/);
  const outcomes = [
    [{ status: "updated", number: 12, url: "u" }, /Updated #12[\s\S]*checkboxes were reset/],
    [{ status: "no-plan" }, /no test plan on this pull request yet[\s\S]*regenerate/],
    [{ status: "no-permission" }, /Issues: write/],
    [{ status: "issues-disabled" }, /Issues are disabled/],
  ] as const;
  for (const [result, pattern] of outcomes) {
    const f = fixture({ createIssue: async () => result });
    await processCommand(keyword, f.deps);
    assert.match(f.effects[0]!, pattern);
  }
  const routed = fixture({ interpret: async () => ({ type: "create-issue" }) });
  assert.deepEqual(await processCommand({ ...base, command: { type: "freeform", text: "make this a ticket" } }, routed.deps), { command: "freeform", interpreted: "create-issue" });
  let called = 0;
  const denied = fixture({ canWrite: async () => false, createIssue: async () => { called++; return { status: "no-plan" }; } });
  await processCommand(keyword, denied.deps);
  assert.equal(called, 0);
});

test("a command that fails on its final attempt tells the commenter; earlier attempts stay quiet", async () => {
  const boom = Object.assign(new Error("db at postgres://secret-host"), { name: "Error" });
  const early = fixture({ remember: async () => { throw boom; } });
  const job = { ...base, command: { type: "remember", text: "x" } } as const;
  await assert.rejects(runCommand(job, false, early.deps), boom);
  assert.deepEqual(early.effects, [], "a retry is coming, so no reply yet");

  const final = fixture({ remember: async () => { throw boom; } });
  await assert.rejects(runCommand(job, true, final.deps), boom);
  assert.equal(final.effects.length, 1);
  assert.match(final.effects[0]!, /couldn't complete that: an unexpected internal error\. [\s\S]*post the comment again/);
  assert.doesNotMatch(final.effects[0]!, /secret-host/);

  const github = fixture({ canWrite: async () => { throw Object.assign(new Error("x"), { name: "HttpError", status: 502 }); }, acknowledge: async () => { throw new Error("github down"); } });
  await assert.rejects(runCommand(job, true, github.deps), /x/, "a failing reply never masks the original error");

  const ok = fixture();
  assert.deepEqual(await runCommand({ ...base, command: { type: "regenerate" } }, true, ok.deps), { command: "regenerate" });
});
