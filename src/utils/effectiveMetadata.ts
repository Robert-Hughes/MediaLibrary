import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  ImageMetadataEntry,
  ImageMetadataOccurrencesState,
  MetadataDraftEdit,
  MetadataValue,
  SchemaDefinitionId,
  TagKind,
} from "../types";
import { metadataValueEqual } from "../types";
import { buildSchemaDraftDisplayProjection } from "../targetDraftView";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import { schemaMetadataCollectionFromOccurrences } from "./schemaMetadataProjection";
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

function listKindFromSchema(
  kind: TagKind | null | undefined,
): "Bag" | "Seq" | "Alt" | undefined {
  return kind?.kind === "Bag" || kind?.kind === "Seq" || kind?.kind === "Alt"
    ? kind.kind
    : undefined;
}

/** Apply one semantic edit only when its exact effective result is known. */
export function applyMetadataDraftEditExactly(
  current: MetadataValue | undefined,
  edit: MetadataDraftEdit,
  schemaKind?: TagKind | null,
):
  | { applied: true; value: MetadataValue | undefined }
  | { applied: false; value: undefined; reason: string } {
  if (edit.intent === "Delete") {
    return { applied: true, value: undefined };
  }
  if (edit.intent === "Set") {
    return {
      applied: true,
      value: edit.value === null ? undefined : structuredClone(edit.value),
    };
  }
  const schemaListKind =
    listKindFromSchema(schemaKind) ??
    (schemaKind == null && current?.kind === "List"
      ? current.value.list_kind === "Bag" ||
        current.value.list_kind === "Seq" ||
        current.value.list_kind === "Alt"
        ? current.value.list_kind
        : undefined
      : undefined);
  if (schemaListKind === undefined) {
    if (edit.intent === "ListRemove" || edit.value === null) {
      return { applied: true, value: undefined };
    }
    if (edit.value.kind === "List") {
      return {
        applied: false,
        value: undefined,
        reason: "A list payload cannot be rendered for a non-list schema.",
      };
    }
    return { applied: true, value: structuredClone(edit.value) };
  }

  if (
    current === undefined &&
    (edit.intent === "ListRemove" || edit.value === null)
  ) {
    return { applied: true, value: undefined };
  }

  const currentList =
    current?.kind === "List"
      ? current.value
      : {
          list_kind: schemaListKind,
          items: current === undefined ? [] : [current],
        };
  const staged = edit.value === null ? [] : listItems(edit.value);
  if (edit.intent === "ListRemove") {
    return {
      applied: true,
      value: {
        kind: "List",
        value: {
          ...structuredClone(currentList),
          items: currentList.items
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
        ...structuredClone(currentList),
        items: [
          ...currentList.items.map((item) => structuredClone(item)),
          ...staged
            .filter(
              (candidate) =>
                !currentList.items.some((item) =>
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
export function buildEffectiveMetadataForFile(
  input: {
    occurrences: ImageMetadataOccurrencesState | undefined;
    targetDrafts: TargetDraftCollection | undefined;
  },
  options: {
    ids?: readonly SchemaDefinitionId[];
  } = {},
): MetadataCollection {
  const requestedTokens = options.ids
    ? new Set(options.ids.map(schemaDefinitionIdToken))
    : null;
  const occurrences =
    Array.isArray(input.occurrences) && requestedTokens !== null
      ? input.occurrences.filter((occurrence) =>
          requestedTokens.has(schemaDefinitionIdToken(occurrence.schema_id)),
        )
      : input.occurrences;
  const targetDrafts =
    input.targetDrafts !== undefined && requestedTokens !== null
      ? Object.fromEntries(
          Object.entries(input.targetDrafts).filter(([, entry]) =>
            requestedTokens.has(
              schemaDefinitionIdToken(entry.target.schema_id),
            ),
          ),
        )
      : input.targetDrafts;

  const effective = Array.isArray(occurrences)
    ? schemaMetadataCollectionFromOccurrences(occurrences)
    : {};

  const displayDrafts = buildSchemaDraftDisplayProjection({
    occurrences,
    targetDrafts,
  });
  for (const { id, edit } of Object.values(displayDrafts)) {
    const current = valueFromEntry(metadataGet(effective, id));
    const matchingOccurrences = Array.isArray(occurrences)
      ? occurrences.filter((occurrence) =>
          schemaDefinitionIdEquals(occurrence.schema_id, id),
        )
      : [];
    const schemaKind =
      matchingOccurrences.length === 1
        ? matchingOccurrences[0].tag_info?.kind
        : undefined;
    const applied = applyMetadataDraftEditExactly(current, edit, schemaKind);
    if (applied.applied) {
      setEffectiveValue(effective, id, applied.value);
    }
  }

  return effective;
}
