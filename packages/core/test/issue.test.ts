import assert from "node:assert/strict";
import test from "node:test";
import { TRACKING_ISSUE_MARKER, numberCases, renderPlanComment, renderTrackingIssue } from "../src/index.js";

const cases = [
  { title: "Low one", description: "d1", steps: ["a", "b"], expected: "e1", priority: "low" as const },
  { title: "Critical one", description: "d2", steps: ["c"], expected: "e2", priority: "critical" as const },
  { title: "High one", description: "d3", steps: ["d"], expected: "e3", priority: "high" as const },
];

test("case numbers in the tracking issue match the PR comment in both layouts", () => {
  for (const style of ["grouped", "flat"] as const) {
    const comment = renderPlanComment({ summary: "S", testCases: cases }, { headSha: "a".repeat(40), promptVersion: "v5" }, style);
    const issue = renderTrackingIssue({ prNumber: 7, prTitle: "Add lockout", headSha: "a".repeat(40), summary: "S", cases, style }).body;
    for (const { num, tc } of numberCases(cases, style)) {
      assert.ok(comment.includes(`${num}. ${tc.title}`), `${style} comment has ${num}. ${tc.title}`);
      assert.ok(issue.includes(`- [ ] **${num}. ${tc.title}**`), `${style} issue has ${num}. ${tc.title}`);
    }
  }
  assert.deepEqual(numberCases(cases, "grouped").map((c) => c.tc.title), ["Critical one", "High one", "Low one"]);
});

test("tracking issue is one checklist with collapsible detail, a marker and a bounded title", () => {
  const { title, body } = renderTrackingIssue({ prNumber: 7, prTitle: "x".repeat(400), headSha: "abcdef123456", summary: "Adds\nlockout", cases, style: "grouped" });
  assert.ok(title.length <= 256 && title.endsWith("(#7)") && title.startsWith("QA: "));
  assert.ok(body.startsWith(TRACKING_ISSUE_MARKER));
  assert.match(body, /QA checklist for #7 at `abcdef1`/);
  assert.match(body, /> Adds lockout/);
  assert.equal(body.split("- [ ] ").length - 1, 3, "one checkbox per case");
  assert.match(body, /<details><summary>Steps and expected result<\/summary>\n\n  d2\n\n  1\. c\n\n  \*\*Expected:\*\* e2\n\n  <\/details>/);
  const sparse = renderTrackingIssue({ prNumber: 1, prTitle: "T", headSha: "a".repeat(40), summary: null, cases: [{ title: "Only", description: null, steps: [], expected: null, priority: "weird" }], style: "flat" });
  assert.match(sparse.body, /- \[ \] \*\*1\. Only\*\* · weird/);
});
