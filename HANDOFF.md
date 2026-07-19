# OxyQA — Session Handoff Snapshot

A snapshot of what's been built and decided, for continuing in another session.
Last updated: current session.

---

## What OxyQA is

A GitHub App that generates QA test plans from PR diffs. A dev pushes a change
(e.g. a login update), and the bot posts a comment with a prioritized, runnable
test checklist. CodeRabbit-adjacent, but for QA test plans rather than code review.

- Domains owned: `oxyqa.com`, `oxyqa.dev`
- Core architectural rule: **same codebase runs as multi-tenant cloud SaaS and
  single-tenant self-hosted** — every component is either self-hostable or
  config-swappable. Nothing depends on a proprietary cloud feature.
- Built from `EdgeQA_Roadmap_v3_Architecture.md` (in ~/Downloads) — Track B.

## Repo

- Location: `/Users/rami/Documents/Code/oxyqa`
- Monorepo: **pnpm workspaces + Turborepo**, TypeScript on Node 22.
- **pnpm is installed at `~/.local/bin`** (no sudo — corepack global symlink failed).
  New shells: `export PATH="$HOME/.local/bin:$PATH"` (already appended to `~/.zshrc`).
- **No Docker installed** — local dev uses Supabase (Postgres) + Upstash (Redis)
  + smee.io (webhook tunnel) instead of containers.
- 3 commits so far: Phase 0 skeleton → Phase 1 slice → LLM increment.

### Layout

```
oxyqa/
├── apps/
│   ├── webhook/   Hono ingress: verify sig → dedup by head SHA → enqueue → 200
│   ├── worker/    BullMQ consumer: fetch diff → generate plan → comment → persist
│   └── dashboard/ Next.js — STUBBED, deferred to Phase 5
├── packages/
│   ├── core/      config, queue, github/diff, prompt, llm, output
│   └── db/        Drizzle schema + client
├── .env.example   config template (committed)
├── .env           real values (GITIGNORED — has a live Anthropic key)
├── SETUP.md       account setup + run instructions
└── README.md
```

## Tech stack (all chosen for the self-hostable/config-swappable rule)

| Layer | Tool |
|---|---|
| Ingress | Hono + `@octokit/webhooks-methods` (signature verify) |
| GitHub auth | `octokit` App + `@octokit/auth-app` (JWT → per-install token) |
| Queue | BullMQ + `ioredis` (pinned 5.11.1) |
| LLM | Vercel AI SDK `generateObject` + Zod + `@ai-sdk/anthropic` |
| DB/ORM | Drizzle + `postgres` (postgres.js) |
| Config | `dotenv` + `zod` |
| Hosting (planned) | Supabase (PG) · Upstash (Redis) · Railway (services) |

## What's built and working

**Ingress → queue → worker → GitHub-auth chain**, plus the full **LLM pipeline**.
Everything typechecks (`pnpm -r typecheck`).

- `packages/core/src/config.ts` — env-driven, zod-validated config. Single place
  that reads `process.env`. Private key via `GITHUB_APP_PRIVATE_KEY` (inline) or
  `GITHUB_APP_PRIVATE_KEY_PATH`. Throws a readable error listing missing vars.
- `packages/core/src/queue.ts` — `PrJob` type, `PR_QUEUE_NAME`, Redis connection
  factory (BullMQ needs `maxRetriesPerRequest: null`), queue factory.
- `packages/db/src/schema.ts` — **multi-tenant: `installation_id` on every table.**
  Tables: `installations`, `plans` (unique idx on `installation_id,repo,head_sha`
  = idempotency), `test_cases`, `feedback`, `usage`.
- `packages/core/src/llm/schema.ts` — Zod `testPlanSchema` (summary + testCases[]
  with title/description/priority/steps/expected).
- `packages/core/src/llm/model.ts` — **provider-agnostic** `resolveModel(llm)`.
  Anthropic wired; openai/azure/bedrock/local throw "not wired yet".
- `packages/core/src/llm/generate.ts` — the single `generateObject` call.
- `packages/core/src/prompt/build.ts` — versioned prompt (`PROMPT_VERSION = "v1"`),
  has a slot for `.oxyqa/context.md` context injection (Phase 2).
- `packages/core/src/github/diff.ts` — `formatDiff()` with a 24k-char budget
  (lightweight context-windowing).
- `packages/core/src/output/comment.ts` — `renderPlanComment()` + `COMMENT_MARKER`
  (`<!-- oxyqa:plan -->`) for update-in-place on re-runs.
- `apps/webhook/src/index.ts` — Hono. Verifies signature, dedups head SHA in Redis
  (`SET NX`), enqueues, returns 200. Only handles `pull_request` events currently.
- `apps/worker/src/index.ts` — full pipeline: install auth → fetch PR + files →
  formatDiff → generateTestPlan → find/update-or-create PR comment → persist plan,
  test cases, usage.

## How to test right now (needs only an Anthropic key)

```bash
export PATH="$HOME/.local/bin:$PATH"
cd ~/Documents/Code/oxyqa
pnpm --filter @oxyqa/worker generate:sample
```

`apps/worker/src/scripts/generate-sample.ts` feeds a hardcoded diff (currently a
full-stack login change: Express route + React form) through the LLM step and
prints the raw structured object AND the rendered Markdown comment. No GitHub/DB/
Redis needed. **Verified working** — produced ~10 quality test cases including a
race-condition case and user-enumeration checks.

## ⚠️ Important gotchas / decisions

1. **Model default is `claude-sonnet-4-6`, NOT Opus.** `claude-opus-4-8` / Opus 4.7
   / Fable **reject the `temperature` parameter**, and the Vercel AI SDK
   (`@ai-sdk/anthropic` 1.2.12) sends `temperature: 0` by default on structured
   output → HTTP 400 "`temperature` is deprecated for this model." The local `.env`
   uses `claude-sonnet-4-6` (works). **`.env.example` template still says
   `claude-opus-4-8` (which errors until fixed).** TODO to support Opus/Fable: stop
   sending sampling params for those models (small change in generate.ts/model.ts).
   This was a deliberate product decision anyway — Sonnet is cheaper + cacheable;
   Opus/Fable reserved for higher tiers.
2. **`ioredis` pinned to 5.11.1** via `pnpm.overrides` in root `package.json` —
   bullmq bundles its own copy and the two ioredis versions had incompatible types.
   Don't remove the override.
3. **Security:** a live Anthropic key briefly sat in the git-tracked `.env.example`;
   moved to gitignored `.env`, user scrubbed the template. **Recommend rotating that
   key** for safety. Never commit `.env`.
4. **pnpm strict linking:** apps must declare direct deps (e.g. worker needed
   `bullmq`, `drizzle-orm`, `dotenv` added explicitly even though transitively present).

## Features discussed but NOT yet built

- **`.oxyqa/context.md` enrichment (Phase 2):** teams commit domain terms/testing
  conventions; injected into every prompt. Prompt builder already has the slot.
- **Reply-to-agent + memory (user wants this):** subscribe to `issue_comment`
  (and `pull_request_review_comment`) events, parse `@oxyqa remember: ...` /
  `@oxyqa change step N` commands, store per-repo memory (new table keyed by
  install+repo — CodeRabbit's "learnings"), inject into prompts. `.oxyqa/context.md`
  = explicit memory; reply-driven = implicit/learned. **When registering the GitHub
  App, subscribe to Issue comments now** so this works later without reconfig.
- **Output modes — a product fork to decide:** current = human-runnable checklist
  (tool-agnostic, safe). Alternative/addition = generate executable tests
  (Playwright/Jest) the dev drops in. Higher-stakes, stack-specific.
- **Comment polish:** cleaner priority badges, `<details>` collapsible, group by
  priority. Current renderer uses emoji badges (🔴 critical) for reliable GH render.

## Going-live plan (the current focus)

Two lanes: **Lane 1 = live for you** (real App, deployed, real PRs in your org),
**Lane 2 = production** (hardening before paying strangers). None of Lane 2 is a
rewrite — it's additive (tables/boundaries already exist).

### Lane 1 setup order (get it on real PRs)

Ordering constraint: the webhook needs a public URL, and the GitHub App points at it.

1. **Supabase + Upstash (parallel, no deps):** get `DATABASE_URL` + `REDIS_URL`
   (Upstash: use a **fixed-price** plan, not pay-as-you-go — BullMQ polls constantly).
2. **Register the GitHub App:** App ID, private key `.pem`, webhook secret.
   Permissions: PRs R/W, Contents R, Metadata R, Checks R/W. Events: **Pull requests
   + Issue comments**. Webhook URL = placeholder for now. Install on a test repo.
3. **Deploy to Railway:** `webhook` + `worker` as two services in one project,
   sharing env vars. Webhook gets a public URL; worker needs none.
4. **Point the GitHub App webhook URL** at the Railway webhook URL (map `api.oxyqa.dev`).
5. **Run migrations** against Supabase.
6. **Open a PR** on the test repo → comment appears.

### To unblock the deploy, still need to BUILD:

- `Dockerfile` (or Railway/nixpacks config) per service + prod start command
  (can run via `tsx` initially, optimize build later).
- **Versioned migrations** (`drizzle generate` + `migrate`) — currently using
  `db:push` which is fine for local but not production.
- `/health` endpoint check + graceful shutdown (queue draining).

Recommended host: **Railway** (fastest today; Fly if multi-region later).

### Lane 2 (production) gap list

Install-lifecycle webhooks (populate/clean tenant rows properly) · bundled build ·
versioned migrations · dead-letter queue + failure alerting · prompt caching (cache
the context prefix) + per-tier model selection + usage caps enforced in worker ·
Langfuse (LLM traces) + Sentry (errors) + structured logs · encrypt stored tokens
at rest, never log diffs, minimize token scope, secret manager for the private key ·
GitHub Marketplace + Stripe billing + entitlement gating in worker · free-tier
gating + graceful GitHub rate-limit handling · privacy policy + ToS + Autodesk PIIA
disclosure.

## Account/setup status

- ✅ GitHub org exists (`OxyQA`)
- ✅ Anthropic API key obtained (in local `.env`) — **still recommend rotating** (gotcha #3)
- ✅ Supabase (`oxyqa-dev`, us-east-1) — connected via **session pooler** (port 5432),
  schema pushed (`installations`, `plans`, `test_cases`, `feedback`, `usage`)
- ✅ Upstash Redis (`oxyqa-dev`, Hobby/free tier) — `rediss://` URL in `.env`.
  Stop the worker when not testing; free tier has a daily command cap.
- ✅ GitHub App **registered + installed** — App ID `4334649`, slug `oxyqa`,
  installed on `ramishah/oxyqa-test`. Perms: PRs R/W, Contents R, Checks R/W,
  Metadata R, Issues R. Events: `pull_request` + `issue_comment`.
- ⬜ Railway — not set up

## ✅ Pipeline verified END-TO-END (this session)

Ran `worker` + `webhook` + `smee` locally and opened a real PR
(`ramishah/oxyqa-test` #1, an account-lockout login change). The `oxyqa` bot
posted a **9-case QA test plan** — including anti-enumeration checks, a
brute-force-bypass case, a pre-existing-counter edge case, and a bcrypt timing
side-channel case. Full GitHub → smee → webhook → BullMQ → worker → Anthropic →
PR comment → Supabase persistence chain confirmed working.

### Bug fixes required to get it running (committed this session)

1. **`config.ts` dotenv path** — `loadDotenv()` only checked cwd, but services run
   with cwd inside `apps/*`. Now walks up from cwd to find the repo-root `.env`
   (and no-ops in prod where env is injected).
2. **`config.ts` private-key path** — `GITHUB_APP_PRIVATE_KEY_PATH` was resolved
   against cwd; now resolved against the `.env`'s own directory.
3. **`queue.ts` queue name** — BullMQ 5.79 rejects `:` in queue names.
   `oxyqa:pr` → `oxyqa-pr`.

### Local run (all three, then open a PR on the test repo)

```bash
export PATH="$HOME/.local/bin:$PATH"
pnpm --filter @oxyqa/worker dev
pnpm --filter @oxyqa/webhook dev
npx smee-client -u https://smee.io/gKnhijDUh4xrdV7 -t http://localhost:3001/webhooks/github
```

## Reference docs in repo

- `SETUP.md` — account setup + local run commands (Supabase/Upstash/smee, no Docker)
- `README.md` — overview, layout, tech stack, getting started
- `.env.example` — every config knob (note: template LLM_MODEL is opus-4-8, see gotcha #1)
