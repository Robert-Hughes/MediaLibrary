import type { BatchFailureKind } from "../types";
import { assertExhaustive } from "../utils/assertExhaustive";

/**
 * Map the backend's `status` / failure `kind` strings to a short
 * human-readable label. Kept here so the dialog is the only place that
 * cares about display copy — the backend wires use the raw kinds for
 * telemetry. Unknown kinds fall through as the raw value so a new
 * failure mode is still legible while we add a proper label.
 */
export function friendlyDescribeFailureLabel(kind: BatchFailureKind): string {
  switch (kind) {
    case "decode":
      return "Could not decode image";
    case "http":
      return "API request failed";
    case "network":
      return "Network error";
    case "incomplete":
      return "Response was truncated";
    case "refused":
      return "Refused by model";
    case "bad_json":
      return "Could not parse model response";
    case "usage_parse":
      return "Description received but token usage could not be measured";
    case "preflight_failed":
      return "Preflight failed before any image was processed";
    case "command_failed":
      return "Describe command failed to start";
    case "cancelled":
      return "Cancelled";
    // Reverse-geocode-only kinds; describe should never emit them, but
    // the union is shared so list them for exhaustiveness.
    case "no_gps":
    case "nominatim_empty":
    case "cache_io":
      return kind;
    // Normaliser-only kinds; describe should never emit them.
    case "ai_call_failed":
      return "AI request failed";
    case "ai_schema_invalid":
      return "AI response did not match expected schema";
    case "ai_rate_limited":
      return "AI request rate-limited";
    case "audit_log_io":
      return "Could not write audit log";
    case "internal":
      return "Internal error";
    case "ai_key_missing":
      return "OpenAI API key not configured";
    default:
      return assertExhaustive(kind);
  }
}

/**
 * Map the backend's `kind` strings to a short human label. Mirrors the
 * AI-description equivalent so the failure-list visual idiom is
 * identical across both flows.
 */
export function friendlyGeocodeFailureLabel(kind: BatchFailureKind): string {
  switch (kind) {
    case "no_gps":
      return "No GPS coordinates";
    case "nominatim_empty":
      return "Nominatim returned no usable address";
    case "http":
      return "Network request failed";
    case "network":
      return "Network error";
    case "cache_io":
      return "Could not read or write the geocache file";
    case "cancelled":
      return "Cancelled";
    case "command_failed":
      return "Geocode command failed to start";
    // Describe-only kinds; geocode should never emit them, but the union
    // is shared so list them for exhaustiveness.
    case "decode":
    case "incomplete":
    case "refused":
    case "bad_json":
    case "usage_parse":
    case "preflight_failed":
      return kind;
    // Normaliser-only kinds; geocode should never emit them.
    case "ai_call_failed":
    case "ai_schema_invalid":
    case "ai_rate_limited":
    case "audit_log_io":
    case "internal":
    case "ai_key_missing":
      return kind;
    default:
      return assertExhaustive(kind);
  }
}

/**
 * Map normaliser BatchFailureKind values to short labels.
 */
export function friendlyNormaliseFailureLabel(kind: BatchFailureKind): string {
  switch (kind) {
    case "ai_call_failed":
      return "AI request failed";
    case "ai_schema_invalid":
      return "AI response did not match expected schema";
    case "ai_rate_limited":
      return "AI request rate-limited";
    case "audit_log_io":
      return "Could not write audit log";
    case "internal":
      return "Internal error";
    case "ai_key_missing":
      return "OpenAI API key not configured";
    case "cancelled":
      return "Cancelled";
    case "command_failed":
      return "Normalise command failed to start";
    case "preflight_failed":
      return "Cost estimate failed before any image was processed";
    case "http":
      return "API request failed";
    case "network":
      return "Network error";
    // Kinds that belong to other batch jobs; listed for exhaustiveness.
    case "decode":
    case "incomplete":
    case "refused":
    case "bad_json":
    case "usage_parse":
    case "no_gps":
    case "nominatim_empty":
    case "cache_io":
      return kind;
    default:
      return assertExhaustive(kind);
  }
}
