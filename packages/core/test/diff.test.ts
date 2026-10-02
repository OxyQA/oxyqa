import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DIFF_BUDGET, fileTier, formatDiff, renderPlanComment, type ChangedFile } from "../src/index.js";

const file = (filename: string, size: number, extra: Partial<ChangedFile> = {}): ChangedFile =>
  ({ filename, status: "modified", additions: 3, deletions: 1, patch: Array.from({ length: Math.ceil(size / 20) }, (_, i) => `+line ${String(i).padStart(12, "0")}`).join("\n").slice(0, size), ...extra });

test("files are tiered: source, then tests, then docs/config, then generated noise", () => {
  assert.equal(fileTier("src/auth/login.ts"), 0);
  assert.equal(fileTier("app/models/user.rb"), 0);
  assert.equal(fileTier("src/auth/login.test.ts"), 1);
  assert.equal(fileTier("apps/worker/test/plans.test.ts"), 1);
  assert.equal(fileTier("pkg/auth/login_test.go"), 1);
  assert.equal(fileTier("README.md"), 2);
  assert.equal(fileTier(".github/workflows/ci.yml"), 2);
  assert.equal(fileTier("package.json"), 2);
  assert.equal(fileTier("pnpm-lock.yaml"), 3);
  assert.equal(fileTier("packages/db/migrations/meta/0003_snapshot.json"), 3);
  assert.equal(fileTier("web/dist/app.min.js"), 3);
});

test("small PRs are unchanged: everything included whole, in a stable order", () => {
  const d = formatDiff([file("b.ts", 100), file("a.ts", 100)]);
  assert.deepEqual([d.included, d.truncated, d.omitted, d.skipped], [2, 0, 0, 0]);
  assert.ok(d.text.indexOf("### b.ts") < d.text.indexOf("### a.ts"), "ties keep GitHub's order");
  assert.doesNotMatch(d.text, /Also changed|truncated/);
});

test("source outranks noise when the budget is tight, regardless of listing order", () => {
  const d = formatDiff([file("a-lock/pnpm-lock.yaml", 900), file("docs/guide.md", 900), file("src/z-core.ts", 900), file("src/z-core.test.ts", 900)], { budget: 2100 });
  assert.match(d.text, /### src\/z-core\.ts/);
  assert.ok(d.text.indexOf("### src/z-core.ts") < d.text.indexOf("### src/z-core.test.ts"));
  assert.match(d.text, /Also changed — diff not shown[\s\S]*pnpm-lock\.yaml \(modified, \+3\/-1\)/);
  assert.ok(d.omitted >= 1);
});

test("a file too big to fit is truncated on a line boundary, never silently dropped", () => {
  const d = formatDiff([file("src/huge.ts", 50_000), file("src/small.ts", 500)], { budget: 10_000 });
  assert.deepEqual([d.included, d.truncated, d.omitted], [2, 1, 0]);
  assert.match(d.text, /### src\/huge\.ts[\s\S]*\[… patch truncated to fit the context budget\]/);
  assert.match(d.text, /### src\/small\.ts/, "one huge file cannot starve the rest (40% cap)");
  assert.ok(d.text.length <= 10_000 + 200);
  const cutLine = d.text.split("\n[… patch truncated")[0]!.split("\n").at(-1)!;
  assert.match(cutLine, /^\+line \d{12}$/, "cut lands on a whole line");
});

test("budget is respected and overflow is named; skipPaths still excludes entirely", () => {
  const many = Array.from({ length: 80 }, (_, i) => file(`src/f${i}.ts`, 2000));
  const d = formatDiff([...many, file("secrets/gen.ts", 100)], { skipPaths: ["secrets/**"] });
  assert.ok(d.text.length <= DEFAULT_DIFF_BUDGET + 3500, `text ${d.text.length}`);
  assert.equal(d.included + d.omitted, 80);
  assert.equal(d.skipped, 1);
  assert.doesNotMatch(d.text, /secrets\/gen\.ts/);
  assert.match(d.text, /…and \d+ more/);
  const binary = formatDiff([{ filename: "logo.png", status: "added", additions: 0, deletions: 0 }]);
  assert.match(binary.text, /no textual diff/);
});

test("plan comment says when a large PR was only partly analyzed", () => {
  const plan = { summary: "S", testCases: [{ title: "T", description: "d", steps: ["s"], expected: "e", priority: "low" as const }] };
  const meta = { headSha: "a".repeat(40), promptVersion: "v5" };
  assert.doesNotMatch(renderPlanComment(plan, { ...meta, coverage: { included: 3, truncated: 0, omitted: 0 } }), /large PR/);
  assert.match(renderPlanComment(plan, { ...meta, coverage: { included: 11, truncated: 2, omitted: 31 } }), /large PR: analyzed 11 of 42 changed files, 2 partially/);
});
