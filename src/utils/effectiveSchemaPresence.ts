import type { TargetDraftCollection } from "../targetDraftEdits";
import { resolveSchemaDraftForPresentation } from "../targetDraftView";
import type {
  FileMetadataOccurrencesState,
  SchemaDefinitionId,
} from "../types";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

export interface EffectiveSchemaPresence {
  tokens: Set<string>;
  ids: Map<string, SchemaDefinitionId>;
}

/**
 * Resolve effective schema presence without conflating it with safe value
 * projection. Ambiguous occurrence values remain present; only a proven unique
 * ExistingOccurrence Delete may remove a schema.
 */
export function effectiveSchemaPresenceForFile(
  occurrences: FileMetadataOccurrencesState | undefined,
  targetDrafts: TargetDraftCollection | undefined,
): EffectiveSchemaPresence {
  const tokens = new Set<string>();
  const ids = new Map<string, SchemaDefinitionId>();

  if (Array.isArray(occurrences)) {
    for (const occurrence of occurrences) {
      const token = schemaDefinitionIdToken(occurrence.schema_id);
      tokens.add(token);
      ids.set(token, occurrence.schema_id);
    }
  }

  const schemaIds = new Map<string, SchemaDefinitionId>();
  for (const { target } of Object.values(targetDrafts ?? {})) {
    schemaIds.set(schemaDefinitionIdToken(target.schema_id), target.schema_id);
  }

  for (const [token, id] of schemaIds) {
    ids.set(token, id);
    const sameSchema = Object.values(targetDrafts ?? {}).filter(
      (entry) => schemaDefinitionIdToken(entry.target.schema_id) === token,
    );
    if (
      sameSchema.some(
        (entry) =>
          entry.target.kind === "NewProperty" && entry.edit.intent === "Set",
      )
    ) {
      tokens.add(token);
      continue;
    }

    const resolution = resolveSchemaDraftForPresentation({
      schemaId: id,
      occurrences,
      targetDrafts,
    });
    if (resolution.kind === "target") {
      if (resolution.entry.edit.intent === "Delete") tokens.delete(token);
      else tokens.add(token);
    } else if (sameSchema.some((entry) => entry.edit.intent !== "Delete")) {
      // An unsafe target may establish presence, but never guessed absence.
      tokens.add(token);
    }
  }

  return { tokens, ids };
}
