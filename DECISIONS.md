# OxyQA — Decision Register

Standing decisions for this project, made deliberately so future sessions
**execute instead of re-litigating**. If reality contradicts a decision (API
changed, assumption broke), surface it and propose an amendment — don't silently
diverge. Product decisions marked *(user, 2026-07-19)* came from Rami directly.

Companions: `README.md` (vision/roadmap) · `DEPLOY.md` (env runbook) ·
`HANDOFF.md` (history through 2026-07-18, partially superseded by this file).

---

## 0. Resume state — Phase 2 merged; robustness ladder (§5) in progress

Staging (2026-10-02): webhook `/health` green at
`oxyqawebhook-staging.up.railway.app`; worker migrated (0000–0002) and
consuming; GitHub App `oxyqa-staging` installed on `OxyQA/oxyqa`. Merge to
`main` auto-deploys staging.

Phase 2 context enrichment (§3) is merged as three PRs: (1) repo context +
prompt caching (#4), (2) `.oxyqa/config.yml` knobs (#5), (3) reply commands +
repo memories, prompt v4 (#6). Live dogfood of #6 runs on the §5.1 PR.

2026-09-26 → 2026-10-02 outage: both free-tier Supabase projects paused
(pooler answered `ENOTFOUND: tenant/user ... not found`). Restored from the
Supabase dashboard; after a restore the direct host comes back first and the
pooler follows ~1–2 min later — wait, don't rotate connection strings. Free
projects pause again after ~1 week idle. User cancelled some paid plans;
continue without reactivating subscriptions. `pnpm test` stays fully offline
(PGlite, stubbed GitHub/model).

§5.1 install lifecycle merged (#7, migration 0003 applied on staging).
Now building: §5.2 failure UX (`feat/failure-ux`), then the MVP gate (§5a).

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
| First revenue | **GitHub Marketplace freemium** (free tier + paid). Self-hosted stays the architecture principle from day one but becomes the *premium tier later*, not the first sale | Phase 5 = Marketplace billing; Stripe/license-key work deferred to the self-hosted tier. **Constraint found 2026-10-02:** paid Marketplace plans require a verified publisher (org 2FA + verified domain) **and ≥100 installs**; a free listing needs only a privacy policy + support contact. So the sequence is direct install link → free listing → paid plans after 100 installs (or bill directly via Stripe sooner — user call when it matters) |

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
(the diff has its own budget — **amended 2026-10-02: 24k → 60k chars
(~15k tokens)** because dogfood PRs showed 27 of 42 files dropped, in
alphabetical order, with any file that didn't fit dropped whole. Diff
windowing now ranks source > tests > docs/config > generated noise, truncates
an oversized file (max 40% of the budget) instead of dropping it, lists
unshown files by name, and the plan footer says when a large PR was only
partly analyzed. Cost: at most ~$0.03 more input per plan on Sonnet 4.6;
revert `DEFAULT_DIFF_BUDGET` if that matters):

1. `.oxyqa/context.md` from the target repo (team-authored domain terms, testing
   conventions). Cap ~6k tokens, truncate tail with a visible notice.
2. Repo memories from reply-to-agent (§4) — latest 20 active, ~2k tokens.
3. Linked tickets: **GitHub issues built** — refs parsed from PR title/body
   (closing keywords first, then mentions, same-repo `#12` / `owner/repo#12` /
   issue URLs; code spans ignored) and the branch name (`12-slug`, `issue-12`);
   max 3 issues, ~600 tokens each, truncated not summarized (no extra LLM
   call). PRs and unreadable issues are skipped; never fails a plan. They are
   per-PR, so they sit in the volatile prompt tail (prompt v5), not the cached
   prefix. Linear keys (`ABC-123`) follow in Phase 3b.
4. Repo README excerpt (first ~1.5k tokens) as fallback orientation.

**Prompt caching:** restructure so `[system + repo context]` is a stable prefix
with Anthropic `cacheControl` (via AI SDK providerOptions); volatile parts
(diff, PR meta) go last. Bump `PROMPT_VERSION` on any structural change.

**Behavior config:** `.oxyqa/config.yml` (safe-subset YAML) for knobs —
`maxCases`, `focusAreas`, `skipPaths` (globs), `commentStyle: grouped|flat`.
Prose context stays in `context.md`. Per-install overrides live in the existing
`installations.config` JSONB.

## 4. Reply-to-agent + repo memory spec (events already subscribed)

- **Trigger:** `issue_comment.created` on PRs, body starts with the app's own mention
  (resolve slug at boot via `GET /app`, works for dev/staging/prod alike).
- **Authorization:** only commenters with repo write/admin (check permission via
  API); ignore all bots.
- **Commands:** `remember: <text>` · `forget <match>` · `regenerate` (re-run for
  current head SHA, bypassing dedup) · `focus: <areas>` (one-shot regenerate
  with emphasis). Unknown → short help reply.
- **Storage:** new table `repo_memories` (id, installation_id, owner, repo,
  content, source `command|inferred`, created_by, active, created_at, source_comment_id).
  `source_comment_id` deduplicates remembered guidance on replay. Only explicit
  command memories are created now; inference remains future work.
- **Limits:** remember/forget input ≤2,000 characters; focus ≤1,000. Forget
  matches literal text case-insensitively, within the installation/owner/repo.
  Latest 20 active memories fit a ~2k-token prompt budget.
- **Regeneration:** new comment = new run at the current open, non-draft head.
  Same-comment retries share a queue ID. Focus lives only in that job/prompt tail.
- **Natural language** *(user, 2026-10-02; built)*: any other text after the
  leading mention is `freeform`. The worker — only after the write-access
  check — routes it with a small model (`LLM_ROUTER_MODEL`, default
  `claude-haiku-4-5`; structured output: intent + text + memory numbers) to
  remember / forget / regenerate / focus / none. The router only chooses:
  `interpretRoutedCommand` re-applies the keyword limits, and forget can only
  pick from the repository's own listed memories. Replies always echo the
  interpretation (guidance saved, memories removed, focus queued). Keyword
  commands stay a no-model fast path; malformed keyword commands get help
  rather than reinterpretation; a router outage degrades to help with no
  retry. Router calls are not metered against the monthly cap (≈ $0.001
  each) — revisit if abused. `pnpm --filter @oxyqa/worker route:sample` is the
  live regression set (12/12 on 2026-10-02); it never runs in CI.
- **Ack:** reply comment via existing PR-comment write. (👍-reaction ack needs
  Issues:write — deferred deliberately; Issues stays read-only until Phase 3a.)

## 5. Robustness ladder (ordered; finish before public beta)

1. **Install lifecycle:** handle `installation` + `installation_repositories`
   (GitHub sends these to every App; no event subscription to tick — confirm
   in the App's recent deliveries after deploy). Webhook enqueues one job per
   delivery; the worker **re-reads state from `GET /app/installations/:id`**
   instead of trusting the payload action, so ordering/retries converge.
   Every job syncs its installation first; suspended/deleted installs skip work.
   Account type comes from GitHub (`User`/`Organization`, `Enterprise` for
   enterprise accounts, `Unknown` if absent) — never defaulted.
   **Uninstall = soft delete** (`installations.deleted_at`); plans, memories
   and usage are kept (installation ids are never reused). **Retention: 30 days** after
   uninstall the worker hard-deletes the installation and everything under it
   (`purgeUninstalled`, at boot and every 6 h) — the figure `docs/public/PRIVACY.md`
   promises; change both together.
2. **Failure UX:** after final retry, set plan `status=failed` and post/update
   the PR comment with a one-line reason + "`@<slug> regenerate` to retry".
   Decision: **comment-first UX; Check Runs stay unused** until exec-test era
   (permission already granted, no code). Implementation: the worker reports
   inside the last attempt (awaited, so shutdown drains it), under the same
   per-PR advisory lock as publishing. The banner is **prepended** to the bot
   comment — a previous plan is never discarded — and the next success
   replaces the whole body. Reasons are fixed user-safe phrases
   (`describeFailure`); raw errors stay in worker logs. Stale/closed PRs and
   runs overtaken by a later success stay quiet. Command-job failures are
   still silent (log only) — revisit if users hit it.
3. **Observability:** built, **off until keys are set** (SDKs load lazily).
   Sentry (`SENTRY_DSN`, free tier) in both services: reports a job once, on
   its final attempt, plus unhandled webhook errors; all SDK data collection
   that could carry customer code is disabled (HTTP bodies, gen-AI I/O, queue
   args, local variables). Langfuse **Cloud** free tier during beta
   (`LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`HOST`): one generation per model call
   with prompt, output, tokens (incl. cache) and latency — this **does** send
   diffs to Langfuse, so it must be named in the privacy note; self-host it
   when the self-hosted tier ships. Structured logging (pino) is low priority.
4. **Free-tier gating:** enforced in the worker pre-LLM. Counts `usage` rows
   (every model run, including regenerations) per installation per **UTC
   calendar month**; default cap **50/mo** (`FREE_MONTHLY_PLAN_LIMIT`).
   Override per install via `installations.config.monthlyPlanLimit`
   (non-negative integer, or `"unlimited"`); invalid values fall back to the
   default, and the key is **not** a repo-yml knob (tenants can't raise their
   own cap). `OXYQA_MODE=self-hosted` is uncapped. Over the cap: no model call,
   plan `status=limited`, and a `[!NOTE]` notice with the reset date on the
   plan comment. Soft cap — concurrent jobs can overshoot by up to the worker
   concurrency (5). Set the dogfood install on staging to `"unlimited"`.

5. **Feedback + metrics (built):** when a PR closes, the worker snapshots
   human 👍/👎 reactions on the plan comment into `feedback` (reactions have
   no webhook; re-collection replaces rows). `pnpm --filter @oxyqa/worker
   metrics [days]` prints installs, plans by status, model runs per posted
   plan (regenerate rate), tokens, feedback and tracking issues straight from
   the database. **No product-analytics service until there is a web surface**
   (landing page/dashboard, Phase 5) — the product lives inside GitHub and the
   database already holds its funnel.

## 5a. MVP gate — "outside teams can install it" *(proposed 2026-10-02, pending user OK)*

Demo on own repos works today via the staging App. Both Apps are private
(installable only on the owner account). Before external installs:
§5.1 ✅ → §5.2 failure UX → **cost guard** (a minimal §5.4 per-install monthly
plan cap, pulled forward from Phase 5 to protect the LLM bill) → §5.3 Sentry →
**prod environment** (rename dev App → `oxyqa-dev`, create prod `oxyqa` App
installable by any account, Railway env #2) → install link + "what leaves
your repo" note. Not MVP: NL replies, Issues/Linear, dashboard, billing.
**Open decision (reopens §8 prod sketch):** Supabase free allows 2 active
projects (dev + staging use both), and the user has cut paid plans — compare
Railway-hosted Postgres/Redis (usage-billed, no pause, no command caps)
against Supabase Pro + Upstash fixed before building prod.

**Redis sizing (measured 2026-10-02):** an idle BullMQ worker + webhook on
staging issued 219 commands / 120 s ≈ **4.7M commands/month**; per-plan job
traffic is tens of commands. Upstash free (500K/mo) cannot host an always-on
worker; the fixed 250MB plan ($10/mo, no command cap) is the right fit and
user count barely moves the bill. Dev Redis stays free — run the dev worker
only while testing.

## 6. Phase 3 sketches

- **3a GitHub Issues (built; needs a permission bump to go live):**
  `@<slug> create issue` (keyword or natural language) → ONE tracking issue
  per PR with the latest posted plan as a tickable checklist (never N issues —
  spam). Case numbers match the PR comment (`numberCases`; `test_cases.position`
  keeps generated order). Re-running updates the same issue
  (`plans.tracking_issue_number`) and resets its checkboxes; a deleted issue is
  replaced. **User action:** bump both Apps' Issues permission R→W (installs
  must re-approve); until then the bot replies that it needs the permission.
  Not built: syncing checkbox state back, auto-closing with the PR.
- **3b Linear:** per-workspace API key stored in install config, **encrypted at
  rest: AES-256-GCM with an `ENCRYPTION_KEY` env var** (no KMS dependency —
  self-hosting rule). Push cases to a configured team/project; write Linear ids
  to `test_cases.external_id` (column exists).

## 7. Tech debt register (deliberate, with exit plans)

| Debt | Exit |
|---|---|
| Prod runs via `tsx` (workspace pkgs resolve to TS source; `node dist` crashes) | Bundle each app with **tsup** during Phase 4 packaging |
| Main model is pinned to `claude-sonnet-4-6`. AI SDK v4 `generateObject` sends `temperature: 0` **and forces `tool_choice`**; current models (Sonnet 5.5, Opus 5.x, Fable 5.x) reject one or both with HTTP 400 (checked 2026-10-02). Haiku 4.5 (router) and Sonnet 4.6 accept both | Upgrade `ai` / `@ai-sdk/anthropic` (v4 → current major, which uses native structured outputs) as its own PR with a `generate:sample` + `route:sample` before/after check; do it with paid-tier model selection or when Sonnet 4.6 nears retirement. Omitting sampling params alone is **not** enough |
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
- **Plan Q&A and inferred memories** — follow-ons to natural-language replies
  (§4): answer questions about the current plan ("why is case 3 critical?"),
  and learn guidance from ordinary review discussion (`source: inferred`,
  column exists). Trigger: beta feedback asks for it.
- **Jira/Xray** — trigger: first enterprise team asks.
- **Executable test generation** — trigger: checklist edit-rate measured & good.
- **Prod environment (Railway env #2, `oxyqa-prod` Supabase paid, fixed-Pro
  Upstash, prod App at `api.oxyqa.dev`)** — trigger: first external team wants in.
- **Stripe + license keys (self-hosted tier; Ed25519-signed offline license)** —
  trigger: self-hosted demand after Marketplace launch.
- **Pricing numbers** — structure decided (free 50 plans/mo; paid = higher caps +
  better model); exact prices set during beta with real usage data.
- **Multi-region / Fly** — trigger: latency complaints, not before.
