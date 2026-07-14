import type {
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "./types";
import type { TargetDraftCollection } from "./targetDraftEdits";
import { schemaDefinitionIdEquals } from "./utils/schemaDefinitionId";

export type TargetDraftSchemaResolution =
  | { kind: "missing" }
  | { kind: "unique"; entry: MetadataDraftEntryV5 }
  | { kind: "ambiguous"; entries: MetadataDraftEntryV5[] };

export function targetDraftSchemaId(
  target: MetadataDraftTarget,
): SchemaDefinitionId {
  return target.schema_id;
}

export function findNewPropertyDraftByExactSchema(
  drafts: TargetDraftCollection | undefined,
  schemaId: SchemaDefinitionId,
): MetadataDraftEntryV5 | undefined {
  return Object.values(drafts ?? {}).find(
    (entry) =>
      entry.target.kind === "NewProperty" &&
      schemaDefinitionIdEquals(entry.target.schema_id, schemaId),
  );
}

/**
 * Temporary Add Property view: a schema may resolve to at most one exact
 * target draft. Never first-select when reconciled occurrences are ambiguous.
 */
export function resolveTargetDraftByExactSchema(
  drafts: TargetDraftCollection | undefined,
  schemaId: SchemaDefinitionId,
): TargetDraftSchemaResolution {
  const entries = Object.values(drafts ?? {}).filter((entry) =>
    schemaDefinitionIdEquals(targetDraftSchemaId(entry.target), schemaId),
  );
  if (entries.length === 0) return { kind: "missing" };
  if (entries.length === 1) return { kind: "unique", entry: entries[0] };
  return { kind: "ambiguous", entries };
}

export function targetDraftSchemas(
  drafts: TargetDraftCollection | undefined,
): SchemaDefinitionId[] {
  const result: SchemaDefinitionId[] = [];
  for (const entry of Object.values(drafts ?? {})) {
    const id = targetDraftSchemaId(entry.target);
    if (!result.some((candidate) => schemaDefinitionIdEquals(candidate, id))) {
      result.push(id);
    }
  }
  return result;
}
