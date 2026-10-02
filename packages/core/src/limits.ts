// Free-tier gating (DECISIONS.md §5.4): a per-installation monthly cap on plan
// generations, enforced by the worker before any LLM call. The cap protects the
// hosted LLM bill; self-hosted deployments bring their own key and are uncapped.

/** Default cap for cloud installs: plan generations per UTC calendar month. */
export const FREE_MONTHLY_PLAN_LIMIT = 50;

/** `installations.config` key. Deliberately not a repo-yml knob: tenants must
 * not be able to raise their own cap from `.oxyqa/config.yml`. */
export const MONTHLY_PLAN_LIMIT_KEY = "monthlyPlanLimit";

/**
 * Resolves the cap for one installation; null means unlimited.
 * Override values: a non-negative integer (0 blocks generation) or "unlimited".
 * Anything else falls back to the default — a typo must never lift the cap.
 */
export function resolveMonthlyPlanLimit(
  mode: "cloud" | "self-hosted",
  installConfig?: Record<string, unknown> | null,
): number | null {
  if (mode === "self-hosted") return null;
  const override = installConfig?.[MONTHLY_PLAN_LIMIT_KEY];
  if (override === "unlimited") return null;
  if (typeof override === "number" && Number.isInteger(override) && override >= 0) return override;
  return FREE_MONTHLY_PLAN_LIMIT;
}

/** The UTC calendar month containing `now`: usage window start and reset time. */
export function monthWindow(now: Date): { start: Date; resetsAt: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), resetsAt: new Date(Date.UTC(y, m + 1, 1)) };
}
