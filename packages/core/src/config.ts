// Centralized, env-driven configuration. Nothing else in the codebase reads
// process.env directly — this is the single boundary that makes the same code
// run as cloud SaaS and self-hosted (Phase 0/4 principle).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Services run with their cwd inside apps/* (via `pnpm --filter … dev`), but the
// single .env lives at the monorepo root. Walk up from the cwd to find it so the
// same code works from any package. In prod (Railway/Fly) there's no .env file —
// env vars are injected — so no file is found and dotenv is simply skipped.
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envPath = findEnvFile(process.cwd());
loadDotenv(envPath ? { path: envPath } : undefined);

// Relative paths in .env (e.g. the private key) are resolved against the .env's
// own directory (the repo root), not the process cwd which varies per service.
const envDir = envPath ? dirname(envPath) : process.cwd();

// `.env` files carry empty placeholders (`SENTRY_DSN=`); treat them as unset.
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const schema = z.object({
  OXYQA_MODE: z.enum(["cloud", "self-hosted"]).default("cloud"),

  // GitHub App
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),

  // Infra
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().min(1),

  // LLM (provider-agnostic)
  LLM_PROVIDER: z.enum(["anthropic", "openai", "azure", "bedrock", "local"]).default("anthropic"),
  LLM_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Observability — all optional; unset means the integration is off.
  SENTRY_DSN: optionalString,
  SENTRY_ENVIRONMENT: optionalString,
  RAILWAY_ENVIRONMENT_NAME: optionalString,
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  LANGFUSE_HOST: optionalString,

  // Ports. WEBHOOK_PORT wins if set; PORT is what Railway/Fly inject.
  WEBHOOK_PORT: z.coerce.number().optional(),
  PORT: z.coerce.number().optional(),
});

type RawEnv = z.infer<typeof schema>;

function resolvePrivateKey(env: RawEnv): string {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY;
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return readFileSync(resolve(envDir, env.GITHUB_APP_PRIVATE_KEY_PATH), "utf8");
  }
  throw new Error(
    "Missing GitHub App private key: set GITHUB_APP_PRIVATE_KEY (inline PEM) or GITHUB_APP_PRIVATE_KEY_PATH (path to .pem).",
  );
}

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }
  const env = parsed.data;
  return {
    mode: env.OXYQA_MODE,
    github: {
      appId: env.GITHUB_APP_ID,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      privateKey: resolvePrivateKey(env),
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    },
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    llm: {
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    },
    errorReporting: {
      dsn: env.SENTRY_DSN,
      environment: env.SENTRY_ENVIRONMENT ?? env.RAILWAY_ENVIRONMENT_NAME ?? "development",
    },
    llmTracing: {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      host: env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
    },
    webhookPort: env.WEBHOOK_PORT ?? env.PORT ?? 3001,
  };
}

export type Config = ReturnType<typeof load>;

let cached: Config | undefined;

/** Lazily load + validate config once. Throws a readable error if the env is incomplete. */
export function getConfig(): Config {
  if (!cached) cached = load();
  return cached;
}
