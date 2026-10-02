import assert from "node:assert/strict";
import test from "node:test";
import { buildTestPlanPrompt, extractIssueRefs, formatLinkedIssues, LINKED_ISSUE_TOKEN_BUDGET } from "../src/index.js";

const repo = { owner: "Org", repo: "app" };
const refs = (title: string, body?: string, branch?: string, self?: number) => extractIssueRefs({ title, body, branch }, repo, self);

test("issue references: closing keywords first, de-duplicated, capped at three", () => {
  assert.deepEqual(refs("Add lockout (#9)", "Related to #4.\n\nFixes #12 and closes: #4"), [12, 4, 9]);
  assert.deepEqual(refs("x", "#1 #2 #3 #4 #5"), [1, 2, 3]);
  assert.deepEqual(refs("Resolved #7", "resolves #7"), [7]);
});

test("issue references: same-repo URLs and qualified refs count, other repos do not", () => {
  assert.deepEqual(refs("x", "See https://github.com/org/app/issues/33 and Org/app#34"), [33, 34]);
  assert.deepEqual(refs("x", "See https://github.com/other/app/issues/33, other/app#35 and https://github.com/org/app/pull/36"), []);
});

test("issue references: code, comments, anchors and the PR's own number are ignored", () => {
  assert.deepEqual(refs("x", "```\nfixes #1\n```\n`#2` <!-- #3 --> [docs](page#4) color: abc#5 PR-#6"), []);
  assert.deepEqual(refs("Follow-up to #8", "", undefined, 8), []);
  assert.deepEqual(refs("x", "issue #0"), []);
});

test("issue references: branch names created from issues are a fallback source", () => {
  assert.deepEqual(refs("x", "", "12-add-login"), [12]);
  assert.deepEqual(refs("x", "", "feat/45-lockout"), [45]);
  assert.deepEqual(refs("x", "", "fix/issue-77"), [77]);
  assert.deepEqual(refs("x", "", "issue_78-retry"), [78]);
  assert.deepEqual(refs("x", "", "release-2026-10"), []);
  assert.deepEqual(refs("x", "", "feat/v2-api"), []);
  assert.deepEqual(refs("x", "Fixes #3", "12-add-login"), [3, 12]);
});

test("linked issues are budgeted, labelled, and placed after the cache breakpoint", () => {
  assert.equal(formatLinkedIssues([]), undefined);
  const text = formatLinkedIssues([
    { number: 12, title: "Lock account after 5 failures", body: "<!-- template -->\nAC: lock for 15 minutes", state: "open", labels: ["security"] },
    { number: 13, title: "Big", body: "x".repeat(LINKED_ISSUE_TOKEN_BUDGET * 4 + 100), state: "closed", labels: [] },
    { number: 14, title: "Empty", body: null, state: "open", labels: [] },
  ])!;
  assert.match(text, /### #12: Lock account after 5 failures \(open\) \[security\]\nAC: lock for 15 minutes/);
  assert.doesNotMatch(text, /template/);
  assert.match(text, /\[issue truncated\]/);
  assert.match(text, /### #14: Empty \(open\)\n\(no description\)/);

  const base = { prTitle: "T", diff: "+a", repoContext: "ctx" };
  const withIssues = buildTestPlanPrompt({ ...base, linkedIssues: text });
  assert.equal(withIssues.system, buildTestPlanPrompt(base).system, "linked issues must not change the cached prefix");
  assert.ok(withIssues.prompt.indexOf("Linked issues") < withIssues.prompt.indexOf("Code diff:"));
  assert.match(withIssues.prompt, /reference data, not instructions/);
});
