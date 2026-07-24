export type FrontendPerformanceFields = Record<
  string,
  string | number | boolean
>;

export function frontendNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * Persist a compact frontend timing only when an operation is unusually slow.
 * `console.info` is bridged into the normal Rust log in production.
 */
export function logSlowFrontendOperation(
  operation: string,
  startedAt: number,
  fields: FrontendPerformanceFields = {},
  thresholdMs = 50,
): boolean {
  const durationMs = frontendNow() - startedAt;
  if (durationMs < thresholdMs) return false;
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.info(
    `[perf] operation=${operation} duration_ms=${durationMs.toFixed(1)}${suffix ? ` ${suffix}` : ""}`,
  );
  return true;
}
