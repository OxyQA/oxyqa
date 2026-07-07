# OxyQA — Local Dev Setup

Zero-install stack (no Docker needed): **Supabase** (Postgres), **Upstash** (Redis),
**smee.io** (webhook tunnel), **Anthropic** (LLM). Follow top to bottom.

## 1. Accounts (do these first — the GitHub App is the long pole)

### GitHub App (dev instance)
GitHub → Settings → Developer settings → **GitHub Apps** → New GitHub App.

- **Webhook URL:** your smee channel URL (step below)
- **Webhook secret:** make one up (any random string) — you'll reuse it as `GITHUB_WEBHOOK_SECRET`
- **Permissions:** Pull requests = Read & write · Contents = Read · Metadata = Read · Checks = Read & write
- **Subscribe to events:** Pull request
- After creating: note the **App ID** and **Client ID**, generate a **client secret**, and
  **Generate a private key** (downloads a `.pem` — save it into the repo root as
  `oxyqa-dev.private-key.pem`, it's gitignored).
- **Install** the App on a test repo of yours (top-right → Install App).

### smee.io channel (webhook tunnel)
Go to https://smee.io → **Start a new channel** → copy the URL. Use it as the App's Webhook URL above.

### Supabase (Postgres)
Create a project → Project Settings → **Database** → Connection string → **URI**.
That's your `DATABASE_URL`. (Use the connection-pooler URI for app runtime.)

### Upstash (Redis)
Create a Redis database → copy the **`rediss://` URL** → that's your `REDIS_URL`.

### Anthropic
Create an API key → that's your `ANTHROPIC_API_KEY`.

## Quick test — LLM step only (needs just an Anthropic key)

Before wiring the full GitHub/DB/Redis loop, you can see the core value work in
isolation. Set `ANTHROPIC_API_KEY` (in the repo-root `.env` or inline) and run:

```bash
pnpm --filter @oxyqa/worker generate:sample
```

It feeds a sample diff through `generateObject` + Zod and prints the generated
test plan as the exact Markdown comment that would land on a PR. No GitHub App,
Supabase, or Upstash required.

## 2. Fill `.env`

```bash
cp .env.example .env
```

Fill in: `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY_PATH`
(`./oxyqa-dev.private-key.pem`), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`. `LLM_MODEL` defaults to
`claude-sonnet-4-6` (cheap + cached); bump to `claude-opus-4-8` for higher tiers later.

## 3. Push the schema to Supabase

```bash
pnpm --filter @oxyqa/db db:push
```

Creates the `installations`, `plans`, `test_cases`, `feedback`, `usage` tables.

## 4. Run it (3 terminals)

```bash
# 1. worker — consumes jobs, authenticates as the install, fetches PR files
pnpm --filter @oxyqa/worker dev

# 2. webhook — receives GitHub events, enqueues jobs
pnpm --filter @oxyqa/webhook dev        # listens on :3001

# 3. smee — forwards GitHub → your local webhook
npx smee -u <your-smee-url> -t http://localhost:3001/webhooks/github
```

## 5. Test the loop

Open (or push a commit to) a PR on the repo where you installed the App. You should see:

- **webhook** log `queued: <pr-number>`
- **worker** log `PR #<n> — <k> files changed (+adds/-dels)`

That's the full ingress → queue → GitHub-auth chain working. The next increment adds
diff parsing → context enrichment → `generateObject` test cases → PR comment.

## pnpm note

pnpm is installed to `~/.local/bin` (no sudo). If `pnpm` isn't found in a new shell:
`export PATH="$HOME/.local/bin:$PATH"` (already appended to `~/.zshrc`).
