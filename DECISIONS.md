# OxyQA — Decision Register

Standing decisions for this project, made deliberately so future sessions
**execute instead of re-litigating**. If reality contradicts a decision (API
changed, assumption broke), surface it and propose an amendment — don't silently
diverge. Product decisions marked *(user, 2026-07-19)* came from Rami directly.

Companions: `README.md` (vision/roadmap) · `DEPLOY.md` (env runbook) ·
`HANDOFF.md` (history through 2026-07-18, partially superseded by this file).

---

## 0. Resume state — staging is LIVE; building Phase 2

Staging deploy completed 2026-08-22: webhook `/health` green at
`oxyqawebhook-staging.up.railway.app`; worker migrated and consuming; GitHub App
`oxyqa-staging` installed on `OxyQA/oxyqa`; dogfood verified (staging bot posted
a test plan on PR #3). Merge to `main` auto-deploys staging.

Current build: **Phase 2 context enrichment (§3)**, sliced as three PRs —
(1) ✅ repo context (`.oxyqa/context.md` / README) + prompt-caching restructure,
(2) ✅ `.oxyqa/config.yml` behavior knobs (defaults ← yml ← install JSONB;
prompt v3; this repo dogfoods `commentStyle: grouped`),
(3) reply-to-agent + repo memories (§4) — next.

Guided-setup style that worked: agent gives exact dashboard steps + verifies
each credential via API before moving on; **secrets never pasted into chat**
(user edits `.env`/Railway directly; agent verifies presence/shape only).

---

## 1. Product decisions *(user, 2026-07-19)*

| Decision | Choice | Consequences |
|---|---|---|
| First users / ICP | **Indie & startup teams** (small eng teams, no dedicated QA) | Linear over Jira; light compliance urgency; low-friction pricing; GitHub-native UX is the product's home |
| Integration order | **GitHub Issues first, then Linear.** Jira/Xray only on real enterprise pull | Phase 3a = GitHub-native, 3b = Linear; Xray drops out of near-term scope |
| Output mode | **Human-runnable checklist is the core product; executable tests (Playwright first) come later as opt-in premium** — only after checklist quality is proven via edit-rate/feedback | Phase 2 optimizes checklist quality; no exec-test work before quality metrics exist |
| First revenue | **GitHub Marketplace freemium** (free tier + paid). Self-hosted stays the architecture principle from day one but becomes the *premium tier later*, not the first sale | Phase 5 = Marketplace billing; Stripe/license-key work deferred to the self-hosted tier |

## 2. Standing conventions (decided, in force now)

- **Environments, not branches.** One `main`; local/staging/prod differ only in
  env vars + backing services. Never create a `staging` branch. Never share a
  Redis or Postgres across environments.
- **All changes via PR to `main` with green CI.** Solo flow: self-merge without
  review is fine. Merge → staging auto-deploys. Prod (when it exists) moves only
  on git tags `v*`.
- **Migration discipline:** any `schema.ts` change ships `db:generate` output in
  the same PR. Deployed envs run `db:migrate` on deploy (worker start command);
  local dev keeps `db:push`.
- **Secrets:** never in chat, never in git. Local = `.env` (gitignored), staging =
  Railway vars, GitHub App key on Railway = `GITHUB_APP_PRIVATE_KEY` inline PEM.
- **Model default:** `claude-sonnet-4-6` everywhere until the temperature fix
  (§7) lands; Opus/Fable reserved for paid tiers later.
- **LLM calls never run in CI** (cost); quality checks happen via the sample
  script and staging dogfood.

## 3. Phase 2 spec — context enrichment (next major build)

Priority-ordered context sources, under a **~12k-token total context budget**
(diff keeps its existing 24k-char budget):

1. `.oxyqa/context.md` from the target repo (team-authored domain terms, testing
   conventions). Cap ~6k tokens, truncate tail with a visible notice.
2. Repo memories from reply-to-agent (§4) — latest 20 active, ~2k tokens.
3. Linked tickets: parse GitHub `#123` refs (Phase 3a) and Linear keys
   (`ABC-123`, Phase 3b) from PR title/body/branch name; fetch + summarize.
4. Repo README excerpt (first ~1.5k tokens) as fallback orientation.

**Prompt caching:** restructure so `[system + repo context]` is a stable prefix
with Anthropic `cacheControl` (via AI SDK providerOptions); volatile parts
(diff, PR meta) go last. Bump `PROMPT_VERSION` on any structural change.

**Behavior config:** `.oxyqa/config.yml` (safe-subset YAML) for knobs —
`maxCases`, `focusAreas`, `skipPaths` (globs), `commentStyle: grouped|flat`.
Prose context stays in `context.md`. Per-install overrides live in the existing
`installations.config` JSONB.

## 4. Reply-to-agent + repo memory spec (events already subscribed)

- **Trigger:** `issue_comment.created` on PRs, body mentions the app's own slug
  (resolve slug at boot via `GET /app`, works for dev/staging/prod alike).
- **Authorization:** only commenters with repo write/admin (check permission via
  API); ignore all bots.
- **Commands:** `remember: <text>` · `forget <match>` · `regenerate` (re-run for
  current head SHA, bypassing dedup) · `focus: <areas>` (one-shot regenerate
  with emphasis). Unknown → short help reply.
- **Storage:** new table `repo_memories` (id, installation_id, owner, repo,
  content, source `command|inferred`, created_by, active, created_at).
- **Ack:** reply comment via existing PR-comment write. (👍-reaction ack needs
  Issues:write — deferred deliberately; Issues stays read-only until Phase 3a.)

## 5. Robustness ladder (ordered; finish before public beta)

1. **Install lifecycle:** subscribe both Apps to `installation` +
   `installation_repositories`; handler upserts/suspends `installations` rows
   and fixes the hardcoded `accountType: "Organization"` in the worker.
2. **Failure UX:** after final retry, set plan `status=failed` and post/update
   the PR comment with a one-line reason + "`@<slug> regenerate` to retry".
   Decision: **comment-first UX; Check Runs stay unused** until exec-test era
   (permission already granted, no code).
3. **Observability:** Sentry (free tier) in both services at first external
   user; Langfuse **Cloud** free tier during beta (self-host it only when the
   self-hosted product tier ships). Structured logging (pino) is low priority.
4. **Free-tier gating:** enforce in worker pre-LLM — count plans per
   installation per calendar month; initial cap **50 plans/mo** (constant, per-
   install override via config JSONB). Build alongside Phase 5.

## 6. Phase 3 sketches

- **3a GitHub Issues (command-driven first):** `@<slug> create issues` on a plan
  → ONE tracking issue containing the checklist (never N issues — spam).
  Requires bumping App perm Issues R→W at build time (users re-approve).
- **3b Linear:** per-workspace API key stored in install config, **encrypted at
  rest: AES-256-GCM with an `ENCRYPTION_KEY` env var** (no KMS dependency —
  self-hosting rule). Push cases to a configured team/project; write Linear ids
  to `test_cases.external_id` (column exists).

## 7. Tech debt register (deliberate, with exit plans)

| Debt | Exit |
|---|---|
| Prod runs via `tsx` (workspace pkgs resolve to TS source; `node dist` crashes) | Bundle each app with **tsup** during Phase 4 packaging |
| Opus/Fable reject AI-SDK's default `temperature:0` on structured output (HTTP 400) | In `model.ts`/`generate.ts`, omit sampling params for opus-4-x/fable model ids; implement with paid-tier model selection |
| `ioredis` pinned 5.11.1 via pnpm override (bullmq type clash) | Revisit on bullmq major bump only |
| Dev DB is `db:push`-managed (no migration history) | Acceptable permanently for local; staging/prod are migration-managed from first deploy |
| `apps/dashboard` is a stub | Phase 5: Next.js on Railway; sign-in = GitHub OAuth via the App (that's when callback URL gets set) |
| Dev App owns the clean slug `oxyqa` | When creating the **prod** App, first rename dev App → `oxyqa-dev` to free the slug |

## 8. Deliberately deferred (with revisit triggers)

- **Auto-generated repo context (first-run bootstrap)** *(user, 2026-08-22)* —
  when a repo has no `.oxyqa/context.md`, generate a starter one from repo
  signals (README, file tree, test dirs, manifests) instead of relying on the
  bare README excerpt. Two candidate shapes, pick at build time: (a) worker-side
  behind a config toggle, or (b) a dashboard onboarding step (Phase 5) that
  opens a PR adding the drafted file — PR form preferred so the team reviews
  and owns the content. Costs an extra LLM call, so it must respect free-tier
  gating. Trigger: Phase 5 onboarding build, or earlier if README-fallback
  plan quality proves weak in beta.
- **Jira/Xray** — trigger: first enterprise team asks.
- **Executable test generation** — trigger: checklist edit-rate measured & good.
- **Prod environment (Railway env #2, `oxyqa-prod` Supabase paid, fixed-Pro
  Upstash, prod App at `api.oxyqa.dev`)** — trigger: first external team wants in.
- **Stripe + license keys (self-hosted tier; Ed25519-signed offline license)** —
  trigger: self-hosted demand after Marketplace launch.
- **Pricing numbers** — structure decided (free 50 plans/mo; paid = higher caps +
  better model); exact prices set during beta with real usage data.
- **Multi-region / Fly** — trigger: latency complaints, not before.
