import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  ImageMetadataEntry,
  ImageMetadataOccurrencesState,
  MetadataDraftCollection,
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { metadataValueEqual } from "../types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./metadataDraftTarget";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolveExactMetadataOccurrence,
  resolutionForSchema,
} from "./metadataOccurrences";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";

function valueFromEntry(
  entry: ImageMetadataEntry | undefined,
): MetadataValue | undefined {
  if (entry === undefined) return undefined;
  const { id: _id, ...value } = entry;
  return structuredClone(value as MetadataValue);
}

function listItems(value: MetadataValue): MetadataValue[] {
  return value.kind === "List" ? value.value.items : [value];
}

/** Apply one semantic edit only when its exact effective result is known. */
export function applyMetadataDraftEditExactly(
  current: MetadataValue | undefined,
  edit: MetadataDraftEdit,
): { applied: boolean; value: MetadataValue | undefined } {
  if (edit.intent === "Delete") {
    return { applied: true, value: undefined };
  }
  if (edit.intent === "Set") {
    return {
      applied: true,
      value: edit.value === null ? undefined : structuredClone(edit.value),
    };
  }
  if (current?.kind !== "List" || edit.value === null) {
    return { applied: false, value: current };
  }

  const staged = listItems(edit.value);
  if (edit.intent === "ListRemove") {
    return {
      applied: true,
      value: {
        kind: "List",
        value: {
          ...structuredClone(current.value),
          items: current.value.items
            .filter(
              (item) =>
                !staged.some((candidate) =>
                  metadataValueEqual(item, candidate),
                ),
            )
            .map((item) => structuredClone(item)),
        },
      },
    };
  }

  return {
    applied: true,
    value: {
      kind: "List",
      value: {
        ...structuredClone(current.value),
        items: [
          ...current.value.items.map((item) => structuredClone(item)),
          ...staged
            .filter(
              (candidate) =>
                !current.value.items.some((item) =>
                  metadataValueEqual(item, candidate),
                ),
            )
            .map((item) => structuredClone(item)),
        ],
      },
    },
  };
}

function setEffectiveValue(
  effective: MetadataCollection,
  id: SchemaDefinitionId,
  value: MetadataValue | undefined,
): void {
  const token = schemaDefinitionIdToken(id);
  if (value === undefined) {
    delete effective[token];
    return;
  }
  effective[token] = {
    ...structuredClone(value),
    id: structuredClone(id),
  } as ImageMetadataEntry;
}

function hasLegacyOwner(
  drafts: MetadataDraftCollection | undefined,
  id: SchemaDefinitionId,
): boolean {
  return Object.values(drafts ?? {}).some((entry) =>
    schemaDefinitionIdEquals(entry.id, id),
  );
}

/**
 * Build the schema-keyed metadata view used by generated-workflow inputs and
 * overwrite warnings. Ambiguous runtime occurrences and stale target snapshots
 * are never first-selected.
 */
export function buildEffectiveMetadataForFile(input: {
  metadata: MetadataCollection | undefined;
  occurrences: ImageMetadataOccurrencesState | undefined;
  legacyDrafts: MetadataDraftCollection | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): MetadataCollection {
  const effective: MetadataCollection = Object.fromEntries(
    Object.entries(input.metadata ?? {}).map(([token, entry]) => [
      token,
      structuredClone(entry),
    ]),
  );

  const loadedOccurrences = Array.isArray(input.occurrences)
    ? input.occurrences
    : undefined;
  const occurrenceIndex = loadedOccurrences
    ? buildSchemaOccurrenceResolutionIndex(loadedOccurrences)
    : undefined;

  if (occurrenceIndex) {
    for (const resolution of occurrenceIndex.values()) {
      if (
        resolution.kind === "unique" &&
        resolution.occurrence.tag_info !== null
      ) {
        setEffectiveValue(
          effective,
          resolution.occurrence.tag_info.id,
          resolution.occurrence.value,
        );
      }
      // Missing or multiply-resolved schemas retain the compatibility
      // projection. No authoritative sibling is selected or collapsed into
      // this schema-keyed view.
    }
  }

  for (const entry of Object.values(input.legacyDrafts ?? {})) {
    const current = valueFromEntry(metadataGet(effective, entry.id));
    const applied = applyMetadataDraftEditExactly(current, entry.edit);
    if (applied.applied) setEffectiveValue(effective, entry.id, applied.value);
  }

  const targetOwners = new Map<string, MetadataDraftEntryV5[]>();
  for (const entry of Object.values(input.targetDrafts ?? {})) {
    const token = schemaDefinitionIdToken(entry.target.schema_id);
    const owners = targetOwners.get(token);
    if (owners) owners.push(entry);
    else targetOwners.set(token, [entry]);
  }

  for (const owners of targetOwners.values()) {
    if (owners.length !== 1) continue;
    const entry = owners[0];
    const schemaId = entry.target.schema_id;
    if (hasLegacyOwner(input.legacyDrafts, schemaId)) continue;
    if (!loadedOccurrences || !occurrenceIndex) continue;

    let safe: boolean;
    if (entry.target.kind === "ExistingOccurrence") {
      const schemaResolution = resolutionForSchema(occurrenceIndex, schemaId);
      if (schemaResolution.kind !== "unique") continue;
      const exact = resolveExactMetadataOccurrence(
        loadedOccurrences,
        entry.target.occurrence_id,
      );
      if (exact.kind !== "unique") continue;
      const currentTarget = existingOccurrenceTargetFromOccurrence(
        exact.occurrence,
      );
      safe =
        currentTarget.kind === "targetable" &&
        metadataDraftTargetEquals(currentTarget.target, entry.target) &&
        exact.occurrence.tag_info !== null &&
        schemaDefinitionIdEquals(exact.occurrence.tag_info.id, schemaId);
    } else {
      safe =
        resolutionForSchema(occurrenceIndex, schemaId).kind === "missing" &&
        metadataGet(input.metadata ?? {}, schemaId) === undefined;
    }
    if (!safe) continue;

    const current = valueFromEntry(metadataGet(effective, schemaId));
    const applied = applyMetadataDraftEditExactly(current, entry.edit);
    if (applied.applied) setEffectiveValue(effective, schemaId, applied.value);
  }

  return effective;
}
