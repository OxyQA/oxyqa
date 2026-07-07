// Centralized, env-driven configuration. Nothing else in the codebase reads
// process.env directly — this is the single boundary that makes the same code
// run as cloud SaaS and self-hosted (Phase 0/4 principle).
import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

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

  // Ports
  WEBHOOK_PORT: z.coerce.number().default(3001),
});

type RawEnv = z.infer<typeof schema>;

function resolvePrivateKey(env: RawEnv): string {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY;
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
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
    webhookPort: env.WEBHOOK_PORT,
  };
}

export type Config = ReturnType<typeof load>;

let cached: Config | undefined;

/** Lazily load + validate config once. Throws a readable error if the env is incomplete. */
export function getConfig(): Config {
  if (!cached) cached = load();
  return cached;
}
