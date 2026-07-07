// Standalone proof of the core value — no GitHub, no Redis, no Postgres.
// Feeds a hardcoded diff straight through the LLM step and prints the plan +
// the exact Markdown comment that would land on a PR.
//
//   ANTHROPIC_API_KEY=... pnpm --filter @oxyqa/worker generate:sample
//   (or put ANTHROPIC_API_KEY in the repo-root .env)
import { config as loadDotenv } from "dotenv";
import { formatDiff, generateTestPlan, renderPlanComment } from "@oxyqa/core";

loadDotenv({ path: "../../.env" });

const llm = {
  provider: "anthropic",
  model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};

// A small, realistic diff: adds an expiry check to token validation.
const sampleFiles = [
  {
    filename: "src/auth/verifyToken.ts",
    status: "modified",
    additions: 6,
    deletions: 1,
    patch: `@@ -8,7 +8,12 @@ export function verifyToken(token: string): Session {
   const payload = decode(token);
   if (!payload) throw new AuthError("malformed token");
-  return { userId: payload.sub };
+  if (payload.exp && payload.exp * 1000 < Date.now()) {
+    throw new AuthError("token expired");
+  }
+  if (!payload.sub) throw new AuthError("token missing subject");
+  return { userId: payload.sub, expiresAt: payload.exp };
 }`,
  },
];

async function main() {
  if (!llm.anthropicApiKey) {
    console.error("Set ANTHROPIC_API_KEY (in the environment or repo-root .env) to run this.");
    process.exit(1);
  }

  const diff = formatDiff(sampleFiles);
  console.log(`Generating with ${llm.model}...\n`);

  const { plan, usage } = await generateTestPlan(llm, {
    prTitle: "Add token expiry and subject checks to verifyToken",
    prBody: "Tokens were accepted even after expiry. Also guard against a missing subject claim.",
    diff,
  });

  console.log(`--- Test plan (${plan.testCases.length} cases, ${usage.inputTokens}→${usage.outputTokens} tokens) ---\n`);
  console.log(renderPlanComment(plan, { headSha: "sample00", promptVersion: "v1" }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
