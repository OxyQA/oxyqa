# OxyQA — team context for test plans

OxyQA is itself the product under test: a GitHub App that posts QA test plans on
PRs. pnpm/turbo monorepo — `apps/webhook` (Fastify receiver, must stay fast and
always 2xx), `apps/worker` (BullMQ consumer doing the real work), `packages/core`
(domain logic), `packages/db` (Drizzle + Postgres).

Testing conventions:
- Webhook handlers must never lose an event: verify signature failures and
  malformed payloads are rejected without crashing the process.
- Worker jobs must be idempotent — re-delivery of the same PR event should
  update the existing comment, never duplicate it.
- Anything touching env/config must be checked against both staging and a
  fresh local `.env` (environments differ only by env vars, never by branch).
- Migrations: schema changes must ship generated migrations in the same PR;
  test the upgrade path, not just a fresh DB.
- LLM calls are never made in CI — verify prompt/plan changes via the sample
  script (`pnpm --filter @oxyqa/worker generate:sample`) or staging dogfood.
