// Optional observability (DECISIONS.md §5.3). Both integrations are off unless
// configured, and their SDKs are imported lazily — a self-hosted install with
// no keys never loads them and no data leaves the deployment.
//
//   - Error reporting (Sentry): final job failures and webhook errors.
//   - LLM tracing (Langfuse): one generation per model call — prompt, output,
//     token usage, latency. Note this sends prompt content (diffs) to the
//     configured Langfuse host.
//
// Observability must never break the product: every call here swallows its
// own errors.

export interface ErrorContext {
  [tag: string]: string | number | undefined;
}

export interface ErrorReporter {
  enabled: boolean;
  capture(err: unknown, context?: ErrorContext): void;
  shutdown(): Promise<void>;
}

export interface ErrorReportingConfig {
  dsn?: string;
  environment: string;
}

export async function createErrorReporter(cfg: ErrorReportingConfig, service: string): Promise<ErrorReporter> {
  if (!cfg.dsn) return { enabled: false, capture() {}, async shutdown() {} };
  const Sentry = await import("@sentry/node");
  // Errors only, and nothing that could carry customer code: the SDK's default
  // collection (HTTP bodies, gen-AI inputs/outputs, queue task arguments, local
  // variables) is switched off. Events hold the error, its stack and our tags.
  Sentry.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false,
    },
  });
  Sentry.setTag("service", service);
  return {
    enabled: true,
    capture(err, context = {}) {
      try {
        Sentry.withScope((scope) => {
          for (const [k, v] of Object.entries(context)) if (v !== undefined) scope.setTag(k, String(v));
          Sentry.captureException(err);
        });
      } catch { /* never throw from reporting */ }
    },
    async shutdown() {
      try { await Sentry.close(2000); } catch { /* ignore */ }
    },
  };
}

export interface LlmCallRecord {
  name: string;
  model: string;
  system: string;
  prompt: string;
  output?: unknown;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
  startedAt: Date;
  endedAt: Date;
  metadata?: Record<string, string | number | undefined>;
}

export interface LlmObserver {
  record(call: LlmCallRecord): void;
  shutdown(): Promise<void>;
}

export interface LlmTracingConfig {
  publicKey?: string;
  secretKey?: string;
  host: string;
}

export async function createLlmObserver(cfg: LlmTracingConfig): Promise<LlmObserver | null> {
  if (!cfg.publicKey || !cfg.secretKey) return null;
  const { Langfuse } = await import("langfuse");
  const client = new Langfuse({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.host });
  client.on("error", (err: unknown) => console.warn("[oxyqa] langfuse:", (err as Error)?.message ?? err));
  return {
    record(call) {
      try {
        const trace = client.trace({ name: call.name, metadata: call.metadata, tags: [`prompt:${call.metadata?.promptVersion ?? "unknown"}`] });
        trace.generation({
          name: call.name,
          model: call.model,
          input: [{ role: "system", content: call.system }, { role: "user", content: call.prompt }],
          startTime: call.startedAt,
          metadata: call.metadata,
        }).end({
          output: call.error ? undefined : call.output,
          level: call.error ? "ERROR" : "DEFAULT",
          statusMessage: call.error,
          usageDetails: call.usage && {
            input: call.usage.inputTokens,
            output: call.usage.outputTokens,
            cache_read_input_tokens: call.usage.cacheReadInputTokens,
            cache_creation_input_tokens: call.usage.cacheCreationInputTokens,
          },
        });
      } catch { /* never throw from tracing */ }
    },
    async shutdown() {
      try { await client.shutdownAsync(); } catch { /* ignore */ }
    },
  };
}

/** Runs one model call and reports it to the observer (if any), success or failure. */
export async function observeLlmCall<T extends { output: unknown; usage: LlmCallRecord["usage"] }>(
  observer: LlmObserver | null | undefined,
  base: Pick<LlmCallRecord, "name" | "model" | "system" | "prompt" | "metadata">,
  call: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const record = (rest: Partial<LlmCallRecord>) => {
    try { observer?.record({ ...base, startedAt, endedAt: new Date(), ...rest }); } catch { /* observer bugs stay out of the plan path */ }
  };
  try {
    const result = await call();
    record({ output: result.output, usage: result.usage });
    return result;
  } catch (err) {
    record({ error: (err as Error)?.name ?? "Error" });
    throw err;
  }
}
