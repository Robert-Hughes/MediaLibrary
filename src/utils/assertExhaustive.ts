/**
 * Compile-time exhaustiveness check for `switch` over a discriminated
 * union. Used in failure-label switches (e.g. `BatchFailureKind`) so a
 * new variant added to the Rust enum surfaces as a TypeScript error
 * here rather than silently falling through to the default branch.
 *
 * Usage:
 *   switch (kind) {
 *     case "a": return "...";
 *     case "b": return "...";
 *     default:  return assertExhaustive(kind);
 *   }
 *
 * If `kind` is not exhausted, `assertExhaustive` receives a value typed
 * as the leftover union — which is not `never` — and TypeScript fails
 * the build. At runtime the function still returns a string (the wire
 * form of the kind) so production behaviour is graceful.
 */
export function assertExhaustive(x: never): string {
  return String(x);
}
