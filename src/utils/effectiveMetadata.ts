import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  ImageMetadataEntry,
  ImageMetadataOccurrencesState,
  MetadataDraftEdit,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { metadataValueEqual } from "../types";
import { buildSchemaDraftDisplayProjection } from "../targetDraftView";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import { schemaMetadataCollectionFromOccurrences } from "./schemaMetadataProjection";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

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

/**
 * Build a schema-keyed read-only view from authoritative occurrences and exact
 * target drafts. Ambiguous values and stale targets are never first-selected.
 */
export function buildEffectiveMetadataForFile(input: {
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): MetadataCollection {
  const effective = Array.isArray(input.occurrences)
    ? schemaMetadataCollectionFromOccurrences(input.occurrences)
    : {};

  const displayDrafts = buildSchemaDraftDisplayProjection({
    occurrences: input.occurrences,
    targetDrafts: input.targetDrafts,
  });
  for (const { id, edit } of Object.values(displayDrafts)) {
    const current = valueFromEntry(metadataGet(effective, id));
    const applied = applyMetadataDraftEditExactly(current, edit);
    if (applied.applied) setEffectiveValue(effective, id, applied.value);
  }

  return effective;
}
