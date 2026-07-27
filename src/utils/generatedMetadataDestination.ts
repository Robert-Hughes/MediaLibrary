import { knownMetadataWriteTarget } from "../metadata/knownIds";
import type {
  FileMetadataOccurrencesState,
  MetadataOccurrence,
  MetadataWriteTarget,
  SchemaDefinitionId,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { schemaDefinitionIdEquals } from "./schemaDefinitionId";
import { metadataWriteSelectorsEqual } from "./metadataWriteTarget";

export function declaredGeneratedMetadataDestination(
  schemaId: SchemaDefinitionId,
): MetadataWriteTarget | null {
  return knownMetadataWriteTarget(schemaId);
}

export function occurrenceMatchesDeclaredDestination(
  occurrence: MetadataOccurrence,
  destination: MetadataWriteTarget,
): boolean {
  return (
    occurrence.observed_selector !== null &&
    metadataWriteSelectorsEqual(occurrence.observed_selector, destination)
  );
}

export function occurrencesAtDeclaredDestination(
  occurrences: readonly MetadataOccurrence[],
  schemaId: SchemaDefinitionId,
  destination: MetadataWriteTarget,
): MetadataOccurrence[] {
  return occurrences.filter(
    (occurrence) =>
      schemaDefinitionIdEquals(occurrence.schema_id, schemaId) &&
      occurrenceMatchesDeclaredDestination(occurrence, destination),
  );
}

/**
 * Restrict schemas with a declared generated-metadata destination to that
 * physical destination. Unmapped schemas remain available for read-only
 * context such as generic IPTC-presence detection.
 */
export function filterGeneratedMetadataDestinationView(input: {
  occurrences: FileMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): {
  occurrences: FileMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
} {
  const occurrences = Array.isArray(input.occurrences)
    ? input.occurrences.filter((occurrence) => {
        const destination = declaredGeneratedMetadataDestination(
          occurrence.schema_id,
        );
        return (
          destination === null ||
          occurrenceMatchesDeclaredDestination(occurrence, destination)
        );
      })
    : input.occurrences;

  const targetDrafts =
    input.targetDrafts === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.targetDrafts).filter(([, entry]) => {
            const destination = declaredGeneratedMetadataDestination(
              entry.target.schema_id,
            );
            return (
              destination === null ||
              metadataWriteSelectorsEqual(
                entry.target.write_target,
                destination,
              )
            );
          }),
        );

  return { occurrences, targetDrafts };
}
