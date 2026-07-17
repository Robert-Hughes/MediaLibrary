import { DESCRIBE_TARGET_TAGS } from "../generatedTargetDrafts";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { GEOCODE_TARGET_TAGS } from "../types";
import type {
  ImageMetadataOccurrencesStore,
  SchemaDefinitionId,
} from "../types";
import { effectiveSchemaPresenceForFile } from "./effectiveSchemaPresence";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

export interface OverwriteCount {
  existingCount: number;
  totalCount: number;
}

function countAnyEffectiveSchema(
  relPaths: string[],
  schemas: readonly SchemaDefinitionId[],
  occurrences: ImageMetadataOccurrencesStore,
  targetDrafts: TargetDraftEditsByFile,
): OverwriteCount {
  const targetTokens = new Set(schemas.map(schemaDefinitionIdToken));
  let existingCount = 0;
  for (const relPath of relPaths) {
    const presence = effectiveSchemaPresenceForFile(
      occurrences.get(relPath),
      targetDrafts[relPath],
    );
    if ([...targetTokens].some((token) => presence.tokens.has(token))) {
      existingCount += 1;
    }
  }
  return { existingCount, totalCount: relPaths.length };
}

export function countDescribeOverwrites(
  relPaths: string[],
  occurrences: ImageMetadataOccurrencesStore,
  targetDrafts: TargetDraftEditsByFile,
): OverwriteCount {
  return countAnyEffectiveSchema(
    relPaths,
    DESCRIBE_TARGET_TAGS,
    occurrences,
    targetDrafts,
  );
}

export function countGeocodeOverwrites(
  relPaths: string[],
  occurrences: ImageMetadataOccurrencesStore,
  targetDrafts: TargetDraftEditsByFile,
): OverwriteCount {
  return countAnyEffectiveSchema(
    relPaths,
    GEOCODE_TARGET_TAGS,
    occurrences,
    targetDrafts,
  );
}
