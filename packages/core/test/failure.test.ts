import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMENT_MARKER, FREE_MONTHLY_PLAN_LIMIT, describeFailure, monthWindow, renderFailureComment,
  renderLimitComment, resolveMonthlyPlanLimit, resolveRepoConfig,
} from "../src/index.js";

test("failure reasons are fixed, user-safe phrases that never echo raw messages", () => {
  const secretish = "connect ECONNREFUSED postgres://user:hunter2@db.internal:5432";
  assert.equal(describeFailure(new Error(secretish)), "an unexpected internal error");
  assert.equal(describeFailure({ name: "AI_APICallError", statusCode: 529, message: secretish }), "the model provider was overloaded or unavailable");
  assert.equal(describeFailure({ name: "AI_RetryError", lastError: { name: "AI_APICallError", statusCode: 429 } }), "the model provider was overloaded or unavailable");
  assert.match(describeFailure({ name: "AI_APICallError", statusCode: 401 }), /configuration problem on our side/);
  assert.equal(describeFailure({ name: "AI_APICallError", statusCode: 400 }), "the model provider rejected the request (HTTP 400)");
  assert.equal(describeFailure({ name: "AI_NoObjectGeneratedError" }), "the model returned a plan in an unexpected format");
  assert.equal(describeFailure({ name: "HttpError", status: 502 }), "a GitHub API request failed (HTTP 502)");
  assert.equal(describeFailure({ name: "HttpError", status: 403 }), "GitHub refused or rate-limited a request (HTTP 403)");
  assert.equal(describeFailure(undefined), "an unexpected internal error");
});

test("failure banner keeps a previous plan, replaces an old banner, and stands alone otherwise", () => {
  const meta = { reason: "an unexpected internal error", headSha: "abcdef1234", slug: "oxyqa-staging" };
  const alone = renderFailureComment(null, meta);
  assert.ok(alone.startsWith(COMMENT_MARKER));
  assert.match(alone, /couldn't generate a test plan for `abcdef1`: an unexpected internal error\./);
  assert.match(alone, /`@oxyqa-staging regenerate` to retry\.$/m);
  assert.doesNotMatch(alone, /earlier run/);

  const plan = `${COMMENT_MARKER}\n## 🧪 OxyQA test plan\n\nCase list`;
  const once = renderFailureComment(plan, meta);
  assert.match(once, /earlier run/);
  assert.ok(once.endsWith("## 🧪 OxyQA test plan\n\nCase list"));
  const twice = renderFailureComment(once, { ...meta, reason: "second reason" });
  assert.equal(twice.split("[!WARNING]").length, 2, "exactly one banner");
  assert.match(twice, /second reason/);
  assert.equal(twice.split(COMMENT_MARKER).length, 2, "exactly one update marker");
});

test("monthly plan limit: cloud default, install overrides, self-hosted unlimited, typos never lift the cap", () => {
  assert.equal(resolveMonthlyPlanLimit("cloud", {}), FREE_MONTHLY_PLAN_LIMIT);
  assert.equal(resolveMonthlyPlanLimit("cloud", null), FREE_MONTHLY_PLAN_LIMIT);
  assert.equal(resolveMonthlyPlanLimit("cloud", { monthlyPlanLimit: 500 }), 500);
  assert.equal(resolveMonthlyPlanLimit("cloud", { monthlyPlanLimit: 0 }), 0);
  assert.equal(resolveMonthlyPlanLimit("cloud", { monthlyPlanLimit: "unlimited" }), null);
  for (const bad of [-1, 1.5, "500", "Unlimited", null, true]) {
    assert.equal(resolveMonthlyPlanLimit("cloud", { monthlyPlanLimit: bad }), FREE_MONTHLY_PLAN_LIMIT);
  }
  assert.equal(resolveMonthlyPlanLimit("self-hosted", { monthlyPlanLimit: 1 }), null);
});

test("monthly limit is an install-only setting: repo yml cannot set it, install config is not warned about it", () => {
  assert.match(resolveRepoConfig({ repoYaml: "monthlyPlanLimit: 9999" }).warnings.join(), /unknown key "monthlyPlanLimit"/);
  assert.deepEqual(resolveRepoConfig({ installOverrides: { monthlyPlanLimit: 100 } }).warnings, []);
});

test("usage window is the UTC calendar month, including the December rollover", () => {
  const w = monthWindow(new Date("2026-12-31T23:59:59Z"));
  assert.equal(w.start.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(w.resetsAt.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("limit notice names the cap and reset date and replaces a failure notice", () => {
  const meta = { limit: 50, resetsAt: new Date("2026-11-01T00:00:00Z"), headSha: "abcdef1234", slug: "oxyqa" };
  const failed = renderFailureComment(`${COMMENT_MARKER}\nOld plan`, { reason: "x", headSha: "abcdef1234", slug: "oxyqa" });
  const limited = renderLimitComment(failed, meta);
  assert.match(limited, /\[!NOTE\][\s\S]*limit of 50 test plans per month[\s\S]*resets on November 1 \(UTC\)/);
  assert.doesNotMatch(limited, /WARNING/);
  assert.ok(limited.endsWith("Old plan"));
});
