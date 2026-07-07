# OxyQA

**AI QA test plans from your PR diffs — self-hostable.**

OxyQA is a GitHub App that generates QA test plans and Jira/Xray/Linear test
cases from PR diffs, enriched with project context.

The one architectural decision that shapes everything: **the same codebase runs
as multi-tenant cloud SaaS *and* single-tenant self-hosted.** "Your code never
leaves our infra" is the premium differentiator, so every component is either
self-hostable (Postgres, Redis, Langfuse) or config-swappable (the LLM
provider). Nothing depends on a proprietary cloud feature. Designed for that
from commit one.

## Monorepo layout

pnpm workspaces + Turborepo. Deployable services live in `apps/`, shared
libraries in `packages/`.

```
oxyqa/
├── apps/
│   ├── webhook/     Ingress (Hono). Verify sig → dedup by head SHA → enqueue → 200 fast.
│   ├── worker/      Async processing (BullMQ). Diff → context → prompt → LLM → output → push.
│   └── dashboard/   Next.js. Install mgmt, usage, billing. (Deferred to Phase 5.)
├── packages/
│   ├── core/        Shared domain logic: context enrichment, prompt, LLM orchestration, integrations.
│   └── db/          Drizzle ORM schema + queries: installs, configs, plans, feedback, usage, billing.
├── .env.example     Config-driven from day one — this is what makes self-hosting possible.
├── turbo.json       Task pipeline.
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

> Everything under `src/` is a **Phase 0 skeleton** — placeholders only, no
> logic yet. See the roadmap for what fills them in.

## Tech stack

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript on Node.js |
| Monorepo | pnpm workspaces + Turborepo |
| Ingress / API | Hono + Octokit (`@octokit/auth-app`) |
| Async | BullMQ + Redis |
| LLM | Vercel AI SDK + Zod (provider-agnostic) |
| LLM observability | Langfuse (self-hosted) |
| DB / ORM | Postgres + Drizzle |
| DB hosting | Supabase (cloud) / Postgres container (self-hosted) |
| Integrations | Jira · Xray · Linear |
| Billing | Stripe + GitHub Marketplace |
| Deploy | Railway / Fly (cloud) · Docker Compose (self-hosted) |

*Every choice is self-hostable or config-swappable — that's the through-line.*

## Getting started

Full account setup + run instructions are in **[SETUP.md](SETUP.md)**. Quick version:

```bash
# 1. Install pnpm without sudo (corepack ships with Node 20+)
mkdir -p ~/.local/bin && corepack enable --install-directory ~/.local/bin pnpm
export PATH="$HOME/.local/bin:$PATH"

# 2. Install workspace deps
pnpm install

# 3. Configure (see SETUP.md for where each value comes from)
cp .env.example .env   # then fill it in

# 4. Push schema to Postgres, then run the two services + webhook tunnel
pnpm --filter @oxyqa/db db:push
pnpm --filter @oxyqa/worker dev
pnpm --filter @oxyqa/webhook dev
npx smee -u <smee-url> -t http://localhost:3001/webhooks/github
```

## Build order (from the roadmap)

- **Phase 0** — Foundations: monorepo skeleton (this), register dev GitHub App, local webhook tunnel (smee/cloudflared), `@octokit/auth-app`, local Postgres in Docker, Drizzle schema.
- **Phase 1** — Core loop: webhook → BullMQ → worker → diff parse → `generateObject` + Zod → PR comment. Idempotent on head SHA.
- **Phase 2** — Context enrichment (the differentiator): `.oxyqa/context.md`, repo docs, linked tickets, token-budget windowing, prompt versioning.
- **Phase 3** — Integrations: push to Jira / Xray / Linear, two-way traceability.
- **Phase 4** — Self-hosted packaging: one `docker-compose.yml`, bring-your-own-LLM, license key.
- **Phase 5** — Monetization: GitHub Marketplace, Stripe metering, Next.js dashboard, free-tier gating.
- **Phase 6** — Beta, feedback, launch. Track retention and edit-rate as the core quality metric.

Get the thin vertical slice (Phase 1) working on one real repo before touching
context enrichment, integrations, billing, or the dashboard.
