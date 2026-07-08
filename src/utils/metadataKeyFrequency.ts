import type {
  ImageMetadataStore,
  MetadataDraftEditsByFile,
  PhotoInfo,
} from "../types";

export function computeEffectiveMetadataKeyFrequency(
  photos: PhotoInfo[],
  imageMetadata: ImageMetadataStore,
  draftEdits: MetadataDraftEditsByFile,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const photo of photos) {
    const keysForPhoto = new Set<string>();

    const metadata = imageMetadata.get(photo.relative_path);
    if (metadata !== "loading") {
      for (const key of Object.keys(metadata)) {
        keysForPhoto.add(key);
      }
    }

    const drafts = draftEdits[photo.relative_path];
    if (drafts) {
      for (const key of Object.keys(drafts)) {
        keysForPhoto.add(key);
      }
    }

    for (const key of keysForPhoto) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}
