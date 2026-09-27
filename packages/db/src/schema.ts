// Multi-tenant by construction: every tenant-scoped row carries installationId,
// and every query is expected to filter on it. This is the one thing that is
// genuinely painful to retrofit, so it's here from the first table.
import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** One row per GitHub App installation (an org/user that added OxyQA). The tenant. */
export const installations = pgTable("installations", {
  // GitHub's installation id — the natural tenant key.
  id: bigint("id", { mode: "number" }).primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(), // "Organization" | "User"
  // Per-install settings (output targets, plan gating, etc). Config-driven.
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Explicit maintainer guidance, isolated by installation and repository. */
export const repoMemories = pgTable("repo_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: bigint("installation_id", { mode: "number" }).notNull()
    .references(() => installations.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("command"),
  createdBy: text("created_by").notNull(),
  // Makes replay/retry of remember idempotent, even after queue retention expires.
  sourceCommentId: bigint("source_comment_id", { mode: "number" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byRepo: index("repo_memories_repo_idx").on(t.installationId, t.owner, t.repo, t.active),
  byCommand: uniqueIndex("repo_memories_command_uniq").on(t.installationId, t.sourceCommentId),
}));

/** One generated QA test plan per (installation, repository, PR, head SHA). Idempotency key lives here. */
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status").notNull().default("queued"), // queued | processing | posted | failed | superseded
    promptVersion: text("prompt_version"),
    commentId: bigint("comment_id", { mode: "number" }), // GitHub PR comment id, for update-in-place
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Idempotency: one plan per repo per head SHA. Re-fired events update, not duplicate.
    uniqPlan: uniqueIndex("plans_install_repo_sha_uniq").on(t.installationId, t.owner, t.repo, t.prNumber, t.headSha),
    byInstall: index("plans_installation_idx").on(t.installationId),
  }),
);

/** The individual test cases within a plan. External id links to Jira/Xray/Linear. */
export const testCases = pgTable(
  "test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    steps: jsonb("steps").$type<string[]>().default([]).notNull(),
    expected: text("expected"),
    priority: text("priority"), // low | medium | high | critical
    externalId: text("external_id"), // id in Jira/Xray/Linear once pushed
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byPlan: index("test_cases_plan_idx").on(t.planId) }),
);

/** 👍/👎 on a plan comment — the core quality signal (edit-rate/retention). */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    reaction: text("reaction").notNull(), // "+1" | "-1"
    githubUserId: bigint("github_user_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byInstall: index("feedback_installation_idx").on(t.installationId) }),
);

/** Metered usage for billing + free-tier gating (per PR processed). */
export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byInstall: index("usage_installation_idx").on(t.installationId) }),
);

export const installationsRelations = relations(installations, ({ many }) => ({
  plans: many(plans),
  usage: many(usage),
}));

export const plansRelations = relations(plans, ({ one, many }) => ({
  installation: one(installations, {
    fields: [plans.installationId],
    references: [installations.id],
  }),
  testCases: many(testCases),
  feedback: many(feedback),
}));

export const testCasesRelations = relations(testCases, ({ one }) => ({
  plan: one(plans, { fields: [testCases.planId], references: [plans.id] }),
}));
