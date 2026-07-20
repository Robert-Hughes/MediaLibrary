import type { SchemaDefinitionId, TagInfo } from "./types";
import { gpsMemberGroup } from "./metadata/tag_overrides";

export type MetadataMergeMode = "list-union" | "lang-alt" | null;

export interface MetadataEditCapabilities {
  groupedEditor: "gps" | null;
  mergeMode: MetadataMergeMode;
}

/**
 * Single source of truth for editor features that depend on exact schema
 * identity or TagKind. UI surfaces and planners must not duplicate these
 * decisions.
 */
export function metadataEditCapabilities(
  info: TagInfo,
  propertyId: SchemaDefinitionId = info.id,
): MetadataEditCapabilities {
  if (gpsMemberGroup(propertyId) !== null) {
    return { groupedEditor: "gps", mergeMode: null };
  }

  switch (info.kind.kind) {
    case "Bag":
    case "Seq":
    case "Alt":
      return { groupedEditor: null, mergeMode: "list-union" };
    case "LangAlt":
      return { groupedEditor: null, mergeMode: "lang-alt" };
    default:
      return { groupedEditor: null, mergeMode: null };
  }
}
