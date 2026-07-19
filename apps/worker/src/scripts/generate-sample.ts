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

// A realistic full-stack web-app login change: account lockout after 5 failed
// attempts, generic error messages (anti-enumeration), plus the matching UI.
const sampleFiles = [
  {
    filename: "server/routes/auth.js",
    status: "modified",
    additions: 18,
    deletions: 7,
    patch: `@@ -12,15 +12,28 @@ router.post('/login', async (req, res) => {
   const { email, password } = req.body;
   const user = await db.users.findByEmail(email);
-  if (!user) {
-    return res.status(404).json({ error: 'No account with that email' });
-  }
-  const valid = await bcrypt.compare(password, user.passwordHash);
-  if (!valid) {
-    return res.status(401).json({ error: 'Wrong password' });
-  }
+  if (!user) {
+    return res.status(401).json({ error: 'Invalid credentials' });
+  }
+  if (user.lockedUntil && user.lockedUntil > Date.now()) {
+    return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
+  }
+  const valid = await bcrypt.compare(password, user.passwordHash);
+  if (!valid) {
+    user.failedAttempts = (user.failedAttempts || 0) + 1;
+    if (user.failedAttempts >= 5) {
+      user.lockedUntil = Date.now() + 15 * 60 * 1000;
+    }
+    await db.users.save(user);
+    return res.status(401).json({ error: 'Invalid credentials' });
+  }
+  user.failedAttempts = 0;
+  user.lockedUntil = null;
+  await db.users.save(user);
   const token = signSession(user.id);
   res.json({ token });`,
  },
  {
    filename: "client/src/LoginForm.jsx",
    status: "modified",
    additions: 8,
    deletions: 4,
    patch: `@@ -20,10 +20,17 @@ export function LoginForm() {
     const res = await fetch('/api/login', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ email, password }),
     });
-    if (!res.ok) {
-      setError('Login failed');
-      return;
-    }
+    if (res.status === 423) {
+      setError('Your account is temporarily locked. Try again in 15 minutes.');
+      setLocked(true);
+      return;
+    }
+    if (!res.ok) {
+      setError('Invalid email or password');
+      return;
+    }
     const { token } = await res.json();
     saveToken(token);
     navigate('/dashboard');`,
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
    prTitle: "Lock accounts after 5 failed logins + generic error messages",
    prBody:
      "Adds account lockout (15 min after 5 failed attempts) and switches to generic 'Invalid credentials' errors so attackers can't tell whether an email exists. Frontend shows a lockout message.",
    diff,
  });

  console.log(`Generated ${plan.testCases.length} cases (${usage.inputTokens}→${usage.outputTokens} tokens)\n`);
  console.log("=== RAW STRUCTURED OBJECT (Zod-validated, stored in DB / sent to Jira) ===\n");
  console.log(JSON.stringify(plan, null, 2));
  console.log("\n=== RENDERED PR COMMENT (Markdown) ===\n");
  console.log(renderPlanComment(plan, { headSha: "sample00", promptVersion: "v1" }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
