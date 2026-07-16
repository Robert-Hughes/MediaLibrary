import type {
  ImageMetadataStore,
  PhotoInfo,
  SchemaDefinitionId,
} from "../types";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { metadataIds } from "./metadataCollection";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

export interface MetadataIdFrequency {
  id: SchemaDefinitionId;
  count: number;
}

export function computeEffectiveMetadataKeyFrequency(
  photos: PhotoInfo[],
  imageMetadata: ImageMetadataStore,
  draftEdits: TargetDraftEditsByFile,
): MetadataIdFrequency[] {
  const counts = new Map<string, MetadataIdFrequency>();

  for (const photo of photos) {
    const keysForPhoto = new Set<string>();

    const metadata = imageMetadata.get(photo.relative_path);
    if (metadata !== "loading") {
      for (const id of metadataIds(metadata)) {
        const token = schemaDefinitionIdToken(id);
        keysForPhoto.add(token);
        counts.set(token, counts.get(token) ?? { id, count: 0 });
      }
    }

    const drafts = draftEdits[photo.relative_path];
    if (drafts) {
      for (const { target } of Object.values(drafts)) {
        const id = target.schema_id;
        const token = schemaDefinitionIdToken(id);
        keysForPhoto.add(token);
        counts.set(token, counts.get(token) ?? { id, count: 0 });
      }
    }

    for (const key of keysForPhoto) {
      const current = counts.get(key);
      if (current) current.count += 1;
    }
  }

  return [...counts.values()];
}
