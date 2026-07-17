import type {
  ImageMetadataOccurrencesStore,
  PhotoInfo,
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
  photos: PhotoInfo[],
  occurrencesStore: ImageMetadataOccurrencesStore,
  draftEdits: TargetDraftEditsByFile,
): MetadataIdFrequency[] {
  const counts = new Map<string, MetadataIdFrequency>();

  for (const photo of photos) {
    const keysForPhoto = new Set<string>();
    const idsForPhoto = new Map<string, SchemaDefinitionId>();
    const occurrences = occurrencesStore.get(photo.relative_path);

    if (occurrences !== "loading") {
      for (const occurrence of occurrences) {
        const token = schemaDefinitionIdToken(occurrence.schema_id);
        keysForPhoto.add(token);
        idsForPhoto.set(token, occurrence.schema_id);
      }
    }

    const drafts = draftEdits[photo.relative_path];
    if (drafts) {
      const schemaIds = new Map<string, SchemaDefinitionId>();
      for (const { target } of Object.values(drafts)) {
        schemaIds.set(
          schemaDefinitionIdToken(target.schema_id),
          target.schema_id,
        );
      }
      for (const [token, id] of schemaIds) {
        idsForPhoto.set(token, id);
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
          keysForPhoto.add(token);
          continue;
        }
        const resolution = resolveSchemaDraftForPresentation({
          schemaId: id,
          occurrences,
          targetDrafts: drafts,
        });
        if (resolution.kind !== "target") {
          if (sameSchema.some((entry) => entry.edit.intent !== "Delete")) {
            keysForPhoto.add(token);
          }
          continue;
        }
        if (resolution.entry.edit.intent === "Delete")
          keysForPhoto.delete(token);
        else keysForPhoto.add(token);
      }
    }

    for (const token of keysForPhoto) {
      const id = idsForPhoto.get(token);
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
