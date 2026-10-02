# Self-hosting OxyQA

Run OxyQA entirely on your own infrastructure with Docker Compose: your GitHub
App, your database, your model key. In `self-hosted` mode there is no monthly
plan cap, and nothing is sent to OxyQA's operators. Sentry and Langfuse are off
unless you set their keys.

**You need:** Docker with Compose v2, a hostname GitHub can reach over HTTPS,
and an Anthropic API key (other providers are not wired yet).

## 1. Create your GitHub App

GitHub → your org → Settings → Developer settings → GitHub Apps → New.

| Field | Value |
|---|---|
| Webhook URL | `https://<your-host>/webhooks/github` |
| Webhook secret | a random string — also goes in `.env` |
| Permissions | Contents: read · Pull requests: read & write · Issues: read & write · Metadata: read |
| Events | Pull request, Issue comment |
| Installable on | Only this account |

Generate a private key (`.pem`), note the App ID, and install the App on your
repositories.

## 2. Configure

```bash
cp .env.example .env
```

Set at least:

```bash
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=<the secret from step 1>
# Paste the PEM inline (keep the quotes; newlines as \n or real line breaks):
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
ANTHROPIC_API_KEY=sk-ant-...
POSTGRES_PASSWORD=<choose one>
```

Remove the `GITHUB_APP_PRIVATE_KEY_PATH` line (there is no key file inside the
container). `DATABASE_URL`, `REDIS_URL` and `OXYQA_MODE` are set by Compose and
ignored if present in `.env`.

## 3. Run

```bash
docker compose up -d
docker compose logs -f worker     # expect: listening on queue "oxyqa-pr"
curl http://localhost:3001/health # {"ok":true,"redis":"up"}
```

Put a TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer) in
front of port 3001 and point the App's webhook URL at it. Open a pull request
on an installed repository; the plan comment should appear within a minute.

## Operating it

- **Upgrade:** `git pull && docker compose build && docker compose up -d`.
  Migrations run automatically (`migrate` service) before the worker starts.
- **Backups:** the `postgres-data` volume is the only state that matters
  (plans, saved guidance, usage). Redis holds in-flight jobs only.
- **Metrics:** `docker compose exec worker pnpm --filter @oxyqa/worker metrics`.
- **Model choice:** `LLM_MODEL` (plans) and `LLM_ROUTER_MODEL` (plain-language
  replies) in `.env`.
- **Scaling:** `docker compose up -d --scale worker=3`. Run one `webhook`.
