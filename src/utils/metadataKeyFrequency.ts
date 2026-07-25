import type {
  FileMetadataOccurrencesStore,
  FileInfo,
  SchemaDefinitionId,
} from "../types";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { resolveSchemaDraftForPresentation } from "../targetDraftView";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

export interface MetadataIdFrequency {
  id: SchemaDefinitionId;
  count: number;
}

export function computeEffectiveMetadataKeyFrequency(
  files: FileInfo[],
  occurrencesStore: FileMetadataOccurrencesStore,
  draftEdits: TargetDraftEditsByFile,
): MetadataIdFrequency[] {
  const counts = new Map<string, MetadataIdFrequency>();

  for (const file of files) {
    const keysForFile = new Set<string>();
    const idsForFile = new Map<string, SchemaDefinitionId>();
    const occurrences = occurrencesStore.get(file.relative_path);

    if (occurrences !== "loading") {
      for (const occurrence of occurrences) {
        const token = schemaDefinitionIdToken(occurrence.schema_id);
        keysForFile.add(token);
        idsForFile.set(token, occurrence.schema_id);
      }
    }

    const drafts = draftEdits[file.relative_path];
    if (drafts) {
      const schemaIds = new Map<string, SchemaDefinitionId>();
      for (const { target } of Object.values(drafts)) {
        schemaIds.set(
          schemaDefinitionIdToken(target.schema_id),
          target.schema_id,
        );
      }
      for (const [token, id] of schemaIds) {
        idsForFile.set(token, id);
        const sameSchema = Object.values(drafts).filter(
          (entry) => schemaDefinitionIdToken(entry.target.schema_id) === token,
        );
        if (
          sameSchema.some(
            (entry) =>
              entry.target.kind === "NewProperty" &&
              entry.edit.intent === "Set",
          )
        ) {
          keysForFile.add(token);
          continue;
        }
        const resolution = resolveSchemaDraftForPresentation({
          schemaId: id,
          occurrences,
          targetDrafts: drafts,
        });
        if (resolution.kind !== "target") {
          if (sameSchema.some((entry) => entry.edit.intent !== "Delete")) {
            keysForFile.add(token);
          }
          continue;
        }
        if (resolution.entry.edit.intent === "Delete")
          keysForFile.delete(token);
        else keysForFile.add(token);
      }
    }

    for (const token of keysForFile) {
      const id = idsForFile.get(token);
      if (!id) continue;
      const current = counts.get(token) ?? {
        id: structuredClone(id),
        count: 0,
      };
      current.count += 1;
      counts.set(token, current);
    }
  }

  return [...counts.values()];
}
