import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { installations, plans, type Database } from "@oxyqa/db";
import { syncInstallation, type GitHubInstallation } from "../src/installations.js";

test("installation sync mirrors GitHub state in embedded PostgreSQL", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await client.exec(await readFile(new URL(file, dir), "utf8"));
  const db = drizzle(client);
  let remote: GitHubInstallation | null = { account: { login: "alice", type: "User" }, suspended_at: null };
  const sync = (id = 1) => syncInstallation(db as unknown as Database, id, async () => remote);
  const row = async (id = 1) => (await db.select().from(installations)).find((r) => r.id === id)!;

  await t.test("created: personal accounts keep their real type (no Organization default)", async () => {
    assert.equal(await sync(), "active");
    assert.equal((await row()).accountType, "User");
    assert.equal((await row()).accountLogin, "alice");
  });
  await t.test("enterprise and missing accounts are labelled, not guessed", async () => {
    remote = { account: { slug: "acme" }, suspended_at: null };
    await sync(2);
    assert.deepEqual([(await row(2)).accountLogin, (await row(2)).accountType], ["acme", "Enterprise"]);
    remote = { account: null, suspended_at: null };
    await sync(3);
    assert.equal((await row(3)).accountType, "Unknown");
  });
  await t.test("suspend and unsuspend round-trip; install config survives every sync", async () => {
    await db.update(installations).set({ config: { maxCases: 5 } });
    remote = { account: { login: "alice", type: "User" }, suspended_at: "2026-10-01T00:00:00Z" };
    assert.equal(await sync(), "suspended");
    assert.equal((await row()).suspendedAt?.toISOString(), "2026-10-01T00:00:00.000Z");
    remote = { ...remote, suspended_at: null };
    assert.equal(await sync(), "active");
    assert.equal((await row()).suspendedAt, null);
    assert.deepEqual((await row()).config, { maxCases: 5 });
  });
  await t.test("uninstall soft-deletes and keeps tenant data; replays are no-ops", async () => {
    await db.insert(plans).values({ installationId: 1, owner: "alice", repo: "app", prNumber: 1, headSha: "a".repeat(40) });
    remote = null;
    assert.equal(await sync(), "deleted");
    const deletedAt = (await row()).deletedAt;
    assert.ok(deletedAt);
    assert.equal(await sync(), "deleted");
    assert.equal((await row()).deletedAt?.getTime(), deletedAt.getTime(), "first deletion time is kept");
    assert.equal((await db.select().from(plans)).length, 1);
    assert.equal(await sync(99), "deleted", "unknown deleted installs do not create rows");
    assert.equal((await db.select().from(installations)).length, 3);
  });
});
