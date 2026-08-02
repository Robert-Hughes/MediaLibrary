import { KNOWN_METADATA_IDS } from "./metadata/knownIds";
import type { SchemaDefinitionId } from "./types";

export const DESCRIBE_TARGET_TAGS: readonly SchemaDefinitionId[] = [
  KNOWN_METADATA_IDS.mlibAiDescription,
  KNOWN_METADATA_IDS.mlibAiInterpretation,
  KNOWN_METADATA_IDS.mlibAiTags,
  KNOWN_METADATA_IDS.mlibAiObjects,
  KNOWN_METADATA_IDS.mlibAiOcrText,
  KNOWN_METADATA_IDS.mlibAiModel,
  KNOWN_METADATA_IDS.mlibAiPromptVersion,
  KNOWN_METADATA_IDS.mlibAiGeneratedAt,
] as const;
