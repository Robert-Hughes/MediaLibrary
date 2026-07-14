import type { MetadataOccurrences } from "../types";
import type { MetadataCollection } from "./metadataCollection";
import { wireStructuralEqual } from "./wireStructuralEquality";

/** Exact, order-sensitive equality for authoritative scanner occurrences. */
export function metadataOccurrencesEqualExact(
  left: MetadataOccurrences,
  right: MetadataOccurrences,
): boolean {
  return wireStructuralEqual(left, right);
}

/** Exact schema-keyed equality for the compatibility metadata projection. */
export function metadataCollectionsEqualExact(
  left: MetadataCollection,
  right: MetadataCollection,
): boolean {
  return wireStructuralEqual(left, right);
}
