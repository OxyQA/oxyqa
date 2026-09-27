import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentCommand } from "../src/commands.js";
import { formatRepoMemories, MEMORY_TOKEN_BUDGET } from "../src/context/memories.js";
import { buildTestPlanPrompt } from "../src/prompt/build.js";
import { commandJobId, planJobId } from "../src/queue.js";

test("explicit commands support environment slug and bot suffix", () => {
  assert.deepEqual(parseAgentCommand(" @oxyqa-staging remember: Mobile users matter", "oxyqa-staging"), { type: "remember", text: "Mobile users matter" });
  assert.deepEqual(parseAgentCommand("@oxyqa[bot] FOCUS: keyboard\naccessibility", "oxyqa"), { type: "focus", areas: "keyboard\naccessibility" });
  assert.deepEqual(parseAgentCommand("@oxyqa forget Mobile", "oxyqa"), { type: "forget", match: "Mobile" });
  assert.deepEqual(parseAgentCommand("@oxyqa regenerate", "oxyqa"), { type: "regenerate" });
});

test("ordinary mentions, other bots and quoted commands do not execute", () => {
  for (const body of ["@oxyqa-prod regenerate", "@oxyqa-staging regenerate", "> @oxyqa regenerate", "Example: @oxyqa regenerate", "```\n@oxyqa regenerate\n```", "@oxyqa.foo regenerate"]) {
    assert.equal(parseAgentCommand(body, "oxyqa"), null, body);
  }
});

test("malformed, ambiguous and oversized commands get help", () => {
  for (const body of ["@oxyqa", "@oxyqa remember:", "@oxyqa forget", "@oxyqa focus:", "@oxyqa regenerate please", `@oxyqa remember: ${"a".repeat(2001)}`, `@oxyqa focus: ${"a".repeat(1001)}`]) {
    assert.deepEqual(parseAgentCommand(body, "oxyqa"), { type: "help" });
  }
});

test("memories respect count and token budgets, including truncation notice", () => {
  assert.equal(formatRepoMemories([]), undefined);
  const short = formatRepoMemories(Array.from({ length: 21 }, (_, i) => ({ content: `memory ${i}` })))!;
  assert.match(short, /memory 19/);
  assert.doesNotMatch(short, /memory 20/);
  const long = formatRepoMemories(Array.from({ length: 20 }, () => ({ content: "x".repeat(2000) })))!;
  assert.ok(long.length <= MEMORY_TOKEN_BUDGET * 4);
  assert.match(long, /truncated/);
});

test("focus changes only volatile prompt; memories enter stable prefix", () => {
  const input = { prTitle: "Login", diff: "new login", repoMemories: "Support Safari", repoContext: "A web app" };
  const original = buildTestPlanPrompt(input);
  const focused = buildTestPlanPrompt({ ...input, oneShotFocus: "keyboard access" });
  assert.equal(original.system, focused.system);
  assert.match(original.system, /Support Safari/);
  assert.doesNotMatch(original.prompt, /keyboard access/);
  assert.match(focused.prompt, /keyboard access/);
});

test("queue identifiers isolate installations, repositories, PRs and comments", () => {
  const job = { installationId: 1, owner: "Org", repo: "Repo", prNumber: 1, headSha: "a".repeat(40), action: "opened" };
  const id = planJobId(job);
  for (const patch of [{ installationId: 2 }, { repo: "Other" }, { prNumber: 2 }, { headSha: "b".repeat(40) }]) assert.notEqual(planJobId({ ...job, ...patch }), id);
  assert.equal(planJobId({ ...job, owner: "org", repo: "repo" }), id);
  assert.notEqual(commandJobId({ installationId: 1, commentId: 1 }), commandJobId({ installationId: 1, commentId: 2 }));
  assert.notEqual(planJobId({ ...job, owner: "a-b", repo: "c" }), planJobId({ ...job, owner: "a", repo: "b-c" }));
  assert.ok(!id.includes(":"));
});
