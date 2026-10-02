// Product metrics from the database this environment points at.
//
//   pnpm --filter @oxyqa/worker metrics            # last 30 days, local .env
//   pnpm --filter @oxyqa/worker metrics 7          # last 7 days
//   railway run --service @oxyqa/worker --environment staging pnpm --filter @oxyqa/worker metrics
import { getConfig } from "@oxyqa/core";
import { createDb } from "@oxyqa/db";
import { collectMetrics } from "../metrics.js";

const days = Number(process.argv[2] ?? 30);
if (!Number.isFinite(days) || days <= 0) throw new Error("usage: metrics [days]");
const m = await collectMetrics(createDb(getConfig().databaseUrl), new Date(Date.now() - days * 86_400_000));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
const votes = m.feedback.up + m.feedback.down;
console.log(`OxyQA metrics — last ${days} days (since ${m.since.toISOString().slice(0, 10)})

Installs        ${m.installs.active} active · ${m.installs.suspended} suspended · ${m.installs.uninstalled} uninstalled
Using it        ${m.activeInstalls} installation(s) generated at least one plan
Plans           ${Object.entries(m.plans).map(([s, n]) => `${n} ${s}`).join(" · ") || "none"}
Model runs      ${m.modelRuns} (${m.runsPerPostedPlan ?? "n/a"} per posted plan)
Tokens          ${m.tokens.input.toLocaleString()} in · ${m.tokens.output.toLocaleString()} out
Feedback        👍 ${m.feedback.up} · 👎 ${m.feedback.down} (${pct(m.feedback.up, votes)} positive, on ${m.feedback.plansWithFeedback} plan(s))
Memories        ${m.memories} active
Tracking issues ${m.trackingIssues}`);
process.exit(0);
