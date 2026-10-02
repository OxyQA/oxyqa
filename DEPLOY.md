# OxyQA — Deployment (staging → prod)

Three environments, one codebase. The env **is** the `.env` — no env-specific code.

| | local | staging | prod (later) |
|---|---|---|---|
| GitHub App | dev App (`@ramishah`, ID 4334649) | **OxyQA Staging** (org-owned) | **OxyQA** (org-owned, public) |
| Webhook URL | smee → `localhost:3001` | Railway staging URL | `api.oxyqa.dev` |
| Postgres | Supabase `oxyqa-dev` | Supabase `oxyqa-staging` | Supabase `oxyqa-prod` (paid) |
| Redis | Upstash free (dev) | Upstash **Fixed $10/mo** | Upstash fixed Pro |
| Schema | `db:push` (dev-only) | `db:migrate` on deploy | `db:migrate` on deploy |
| Deploys | `pnpm dev` | auto on merge to `main` | promote via git tag `v*` |

**Rules:** never share a Redis or Postgres between environments (workers steal
each other's jobs). All changes go through PRs to `main`; merging auto-deploys
staging; prod only moves on a tag.

## Railway staging setup (one-time)

1. **New Project** → *Deploy from GitHub repo* → `OxyQA/oxyqa`.
2. Rename the project `oxyqa`, the auto-created environment stays the default
   (treat it as **staging**).
3. Create **two services from the same repo**:
   - **webhook** — Settings → *Config-as-code file path* = `railway.webhook.json`.
     Then Settings → Networking → **Generate Domain** (this URL is the GitHub
     App's webhook target).
   - **worker** — Config-as-code file path = `railway.worker.json`. No domain.
     Its start command runs `db:migrate` first, so migrations apply on every deploy.
4. **Shared variables** (Project → Variables, reference from both services):

   | Variable | Value |
   |---|---|
   | `OXYQA_MODE` | `cloud` |
   | `GITHUB_APP_ID` | staging App's ID |
   | `GITHUB_WEBHOOK_SECRET` | staging App's webhook secret |
   | `GITHUB_APP_PRIVATE_KEY` | staging App's PEM, pasted inline (multiline OK) |
   | `DATABASE_URL` | Supabase `oxyqa-staging` **session pooler** URI (port 5432) |
   | `REDIS_URL` | Upstash staging `rediss://` URL |
   | `LLM_PROVIDER` / `LLM_MODEL` | `anthropic` / `claude-sonnet-4-6` |
   | `ANTHROPIC_API_KEY` | the key |

   Optional observability (both services; unset = off):

   | Variable | Value |
   |---|---|
   | `SENTRY_DSN` | Sentry project DSN (errors only; no bodies, prompts or variables) |
   | `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse project keys (worker only needs them) |
   | `LANGFUSE_HOST` | `https://cloud.langfuse.com` (EU, default) or `https://us.cloud.langfuse.com` — delete any leftover `http://localhost:3000` value |

   The worker logs `observability: errors=sentry|off, llm=langfuse|off` at boot.

   Note: use `GITHUB_APP_PRIVATE_KEY` (inline PEM), **not** `..._PATH` — there is
   no `.pem` file on Railway.

## Staging backing services (one-time)

- **Supabase:** new project `oxyqa-staging`, us-east-1, free tier. No manual
  schema work — the worker's deploy runs `db:migrate`.
- **Upstash:** new Redis DB `oxyqa-staging`, **Fixed 250MB ($10/mo)** — fixed
  price because BullMQ polls constantly; pay-as-you-go bleeds per-command.

## Staging GitHub App (one-time)

Create under the **OxyQA org** (org → Settings → Developer settings → GitHub
Apps): name `OxyQA Staging`, webhook URL = the Railway webhook domain +
`/webhooks/github`, fresh webhook secret. Permissions: Contents R, Pull requests
R/W, Checks R/W, Metadata R, Issues R. Events: `pull_request`, `issue_comment`.
Install on `OxyQA/oxyqa` (dogfooding: staging comments test plans on our own
PRs) and any staging test repos.

## Prod (when ready)

Duplicate the recipe: Railway `production` environment deploying on tag `v*`
only, `oxyqa-prod` Supabase (paid, PITR), fixed-plan Upstash, the real **OxyQA**
App with webhook `api.oxyqa.dev`. Never point two environments at one database.

## Dev note

Local dev keeps `db:push` for fast iteration. Deployed envs are
migration-managed: after changing `schema.ts`, run
`pnpm --filter @oxyqa/db db:generate` and commit the migration with the PR.
