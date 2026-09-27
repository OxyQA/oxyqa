import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "octokit";
import { writeBotComment } from "../src/github-comments.js";

test("comment updates paginate and ignore markers authored by users or other bots", async () => {
  const writes: unknown[] = [];
  const octokit = {
    paginate: { async *iterator() {
      yield { data: [{ id: 1, user: { login: "alice" }, body: "<!-- oxyqa:plan -->" }, { id: 2, user: { login: "other[bot]" }, body: "<!-- oxyqa:plan -->" }] };
      yield { data: [{ id: 3, user: { login: "oxyqa-staging[bot]" }, body: "<!-- oxyqa:plan -->" }] };
    } },
    rest: { issues: { listComments() {}, updateComment: async (data: unknown) => { writes.push(data); }, createComment: async () => { throw new Error("must update"); } } },
  } as unknown as Octokit;
  assert.equal(await writeBotComment(octokit, { owner: "org", repo: "repo", prNumber: 1 }, "oxyqa-staging", "<!-- oxyqa:plan -->", "updated"), 3);
  assert.deepEqual(writes, [{ owner: "org", repo: "repo", comment_id: 3, body: "updated" }]);
});
