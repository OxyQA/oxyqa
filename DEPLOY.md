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
R/W, Checks R/W, Metadata R, Issues R (**R/W** to enable `create issue`). Events: `pull_request`, `issue_comment`.
Install on `OxyQA/oxyqa` (dogfooding: staging comments test plans on our own
PRs) and any staging test repos.

## Prod (when ready) — runbook

Guided-setup style: do one step, report back, the agent verifies the credential
through the API before the next step. Secrets go straight into Railway.

**0. Decide hosting** (open decision, DECISIONS.md §5a). Either
(a) Railway-hosted Postgres + Redis in the prod environment — usage-billed, no
idle pause, no Redis command cap; or (b) Supabase Pro + Upstash fixed.
Never reuse the staging database or Redis.

**1. Free the slug.** GitHub → your personal Developer settings → the dev App →
rename `oxyqa` → `oxyqa-dev`. Update nothing else; the local `.env` uses the
App ID, not the name.

**2. Create the production App** under the **OxyQA org** (org → Settings →
Developer settings → GitHub Apps → New):

| Field | Value |
|---|---|
| Name | `OxyQA` (slug `oxyqa`) |
| Homepage URL | the public site or docs URL |
| Webhook URL | `https://<prod webhook domain>/webhooks/github` (fill after step 4) |
| Webhook secret | new random string (not staging's) |
| Permissions | Contents R · Pull requests R/W · Issues R/W · Metadata R · Checks R/W |
| Events | `pull_request`, `issue_comment` (install events arrive automatically) |
| Where can this App be installed? | **Any account** — this is what lets other teams install it |

Generate a private key. Note the App ID.

**3. Railway `production` environment** in the existing project, with its own
variables (same names as staging): the prod App's `GITHUB_APP_ID`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`; prod `DATABASE_URL` and
`REDIS_URL`; `ANTHROPIC_API_KEY`; `OXYQA_MODE=cloud`; `SENTRY_DSN`; optionally
the Langfuse keys (if set, say so in the privacy note).

**4. Deploy and wire.** Deploy both services to `production`, generate the
webhook domain (or point `api.oxyqa.dev` at it), paste it into the App's
Webhook URL. Worker boot runs `db:migrate`.

Deploys to prod happen on git tags `v*` only. Railway has no tag trigger, so
this needs a small GitHub Action that runs `railway up` for the production
environment on tag push, using a Railway project token stored as a repo secret.
Write and test that Action during the prod session, not before.

**5. Verify** (agent does this): App JWT against `GET /app` shows slug `oxyqa`;
`SELECT` against prod Postgres; `PING` prod Redis; `/health` returns 200; worker
log shows `listening on queue` and the `observability:` line.

**6. Smoke test**: install the prod App on one repo, open a PR, confirm the plan
comment; run each bot command once; close the PR and check
`pnpm --filter @oxyqa/worker metrics` against prod.

**7. Publish**: host `docs/public/INSTALL.md` and `docs/public/PRIVACY.md` at a
public URL (this repo is private), fill their **[owner]** placeholders, and set
the App's public page description, privacy and support links. Share
`https://github.com/apps/oxyqa/installations/new`.

## Dev note

Local dev keeps `db:push` for fast iteration. Deployed envs are
migration-managed: after changing `schema.ts`, run
`pnpm --filter @oxyqa/db db:generate` and commit the migration with the PR.
