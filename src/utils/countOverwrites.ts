import { DESCRIBE_TARGET_TAGS } from "../generatedTargetDrafts";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { GEOCODE_TARGET_TAGS } from "../types";
import type {
  ImageMetadataOccurrencesStore,
  ImageMetadataStore,
} from "../types";
import { buildEffectiveMetadataForFile } from "./effectiveMetadata";
import { metadataHas, type MetadataCollection } from "./metadataCollection";

export interface OverwriteCount {
  existingCount: number;
  totalCount: number;
}

function metadataForPath(
  imageMetadata: ImageMetadataStore,
  relPath: string,
): MetadataCollection | undefined {
  const metadata = imageMetadata.get(relPath);
  return typeof metadata === "object" && metadata !== null
    ? metadata
    : undefined;
}

function countAnyEffectiveSchema(
  relPaths: string[],
  schemas: readonly Parameters<typeof metadataHas>[1][],
  imageMetadata: ImageMetadataStore,
  occurrences: ImageMetadataOccurrencesStore,
  targetDrafts: TargetDraftEditsByFile,
): OverwriteCount {
  let existingCount = 0;
  for (const relPath of relPaths) {
    const effective = buildEffectiveMetadataForFile({
      metadata: metadataForPath(imageMetadata, relPath),
      occurrences: occurrences.get(relPath),
      targetDrafts: targetDrafts[relPath],
    });
    if (schemas.some((id) => metadataHas(effective, id))) existingCount += 1;
  }
  return { existingCount, totalCount: relPaths.length };
}

export function countDescribeOverwrites(
  relPaths: string[],
  imageMetadata: ImageMetadataStore,
  occurrences: ImageMetadataOccurrencesStore,
  targetDrafts: TargetDraftEditsByFile,
): OverwriteCount {
  return countAnyEffectiveSchema(
    relPaths,
    DESCRIBE_TARGET_TAGS,
    imageMetadata,
    occurrences,
    targetDrafts,
  );
}

export function countGeocodeOverwrites(
  relPaths: string[],
  imageMetadata: ImageMetadataStore,
  occurrences: ImageMetadataOccurrencesStore,
  targetDrafts: TargetDraftEditsByFile,
): OverwriteCount {
  return countAnyEffectiveSchema(
    relPaths,
    GEOCODE_TARGET_TAGS,
    imageMetadata,
    occurrences,
    targetDrafts,
  );
}
