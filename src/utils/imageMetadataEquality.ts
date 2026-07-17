import type { MetadataOccurrences } from "../types";
import { wireStructuralEqual } from "./wireStructuralEquality";

/** Exact, order-sensitive equality for authoritative scanner occurrences. */
export function metadataOccurrencesEqualExact(
  left: MetadataOccurrences,
  right: MetadataOccurrences,
): boolean {
  return wireStructuralEqual(left, right);
}
