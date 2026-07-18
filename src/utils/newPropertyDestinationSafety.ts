import type {
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataWriteTarget,
  SchemaDefinitionId,
} from "../types";
import { metadataDraftTargetEquals } from "./metadataDraftTarget";
import { schemaDefinitionIdEquals } from "./schemaDefinitionId";
import { metadataWriteSelectorsEqual } from "./metadataWriteTarget";

export type NewPropertyDestinationSafety =
  | { kind: "available" }
  | { kind: "occupied"; occurrence: MetadataOccurrence }
  | { kind: "unknown-same-schema"; occurrence: MetadataOccurrence }
  | { kind: "pending-collision"; target: MetadataDraftTarget };

/** Classify a New Property destination using the production occupancy rules. */
export function classifyNewPropertyDestination(input: {
  schemaId: SchemaDefinitionId;
  writeTarget: MetadataWriteTarget;
  occurrences: readonly MetadataOccurrence[];
  pendingTargets?: readonly MetadataDraftTarget[];
  ignoredPendingTarget?: MetadataDraftTarget;
}): NewPropertyDestinationSafety {
  const occupied = input.occurrences.find(
    (occurrence) =>
      (occurrence.observed_selector !== null &&
        metadataWriteSelectorsEqual(
          occurrence.observed_selector,
          input.writeTarget,
        )) ||
      (occurrence.write_target !== null &&
        metadataWriteSelectorsEqual(
          occurrence.write_target,
          input.writeTarget,
        )),
  );
  if (occupied) return { kind: "occupied", occurrence: occupied };

  const unknownSameSchema = input.occurrences.find(
    (occurrence) =>
      occurrence.observed_selector === null &&
      schemaDefinitionIdEquals(occurrence.schema_id, input.schemaId),
  );
  if (unknownSameSchema) {
    return { kind: "unknown-same-schema", occurrence: unknownSameSchema };
  }

  const pendingCollision = input.pendingTargets?.find(
    (target) =>
      (!input.ignoredPendingTarget ||
        !metadataDraftTargetEquals(target, input.ignoredPendingTarget)) &&
      metadataWriteSelectorsEqual(target.write_target, input.writeTarget),
  );
  return pendingCollision
    ? { kind: "pending-collision", target: pendingCollision }
    : { kind: "available" };
}
