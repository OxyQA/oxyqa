import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { installations, repoMemories, type Database } from "@oxyqa/db";
import { eq } from "drizzle-orm";
import { createMemoryStore } from "../src/memories.js";
import type { CommandJob } from "@oxyqa/core";

const job: CommandJob = { kind: "command", installationId: 1, owner: "Org", repo: "Repo", prNumber: 2, commentId: 3, actor: "alice", command: { type: "remember", text: "x" } };

test("migrations and memory persistence work in embedded PostgreSQL without hosted services", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  // The store uses PostgreSQL query builders shared by the PGlite and postgres.js drivers.
  const store = createMemoryStore(db as unknown as Database);
  await db.insert(installations).values([
    { id: 1, accountLogin: "Org", accountType: "Organization" },
    { id: 2, accountLogin: "Other", accountType: "Organization" },
  ]);

  await t.test("remember retries create one row and retain author/source", async () => {
    await store.remember(job, "Support Safari"); await store.remember(job, "Support Safari");
    const rows = await db.select().from(repoMemories);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.createdBy, "alice");
    assert.equal(rows[0]!.source, "command"); assert.equal(rows[0]!.owner, "org");
  });
  await t.test("load and forget isolate tenant, owner and repository; case variants refer to same repo", async () => {
    await store.remember({ ...job, installationId: 2, commentId: 4 }, "Support Safari");
    await store.remember({ ...job, repo: "OtherRepo", commentId: 5 }, "Support Safari");
    await store.remember({ ...job, owner: "OtherOwner", commentId: 6 }, "Support Safari");
    assert.equal((await store.load({ ...job, owner: "ORG", repo: "REPO" })).length, 1);
    assert.equal(await store.forget(job, "sAfArI"), 1);
    assert.deepEqual(await store.load(job), []);
    assert.equal((await store.load({ ...job, installationId: 2 })).length, 1);
    assert.equal((await store.load({ ...job, repo: "OtherRepo" })).length, 1);
    assert.equal((await store.load({ ...job, owner: "OtherOwner" })).length, 1);
    await store.remember(job, "Support Safari"); // A replay must not resurrect forgotten guidance.
    assert.deepEqual(await store.load(job), []);
  });
  await t.test("forget uses literal matching, not SQL wildcard patterns", async () => {
    await store.remember({ ...job, commentId: 7 }, "100% coverage for user_name at C:\\tests");
    await store.remember({ ...job, commentId: 8 }, "1000 coverage for username");
    assert.equal(await store.forget(job, "%"), 1);
    assert.equal((await store.load(job)).length, 1);
    assert.equal(await store.forget(job, "_"), 0);
    await store.remember({ ...job, commentId: 9 }, "C:\\tests");
    assert.equal(await store.forget(job, "\\tests"), 1);
  });
  await t.test("only the latest twenty active memories enter context", async () => {
    for (let i = 0; i < 25; i++) {
      await db.insert(repoMemories).values({ installationId: 1, owner: "org", repo: "many", content: `memory ${i}`, createdBy: "alice", createdAt: new Date(2026, 0, i + 1) });
    }
    const rows = await store.load({ ...job, repo: "many" });
    assert.equal(rows.length, 20); assert.equal(rows[0]!.content, "memory 24"); assert.equal(rows[19]!.content, "memory 5");
  });
  await t.test("removing an installation cascades its memories only", async () => {
    await db.delete(installations).where(eq(installations.id, 1));
    const rows = await db.select().from(repoMemories);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.installationId, 2);
  });
});
