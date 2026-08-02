import type { MetadataDraftEdit, SchemaDefinitionId, TagInfo } from "./types";
import type { GpsTagGroup } from "./metadata/tag_overrides";

export type BulkMetadataDraftRequest =
  | {
      operation: "Set";
      tagInfo: TagInfo;
      edit: MetadataDraftEdit;
      merge: boolean;
    }
  | {
      operation: "Delete";
      schemaId: SchemaDefinitionId;
    }
  | {
      operation: "SetGps";
      group: GpsTagGroup;
      edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>;
    }
  | {
      operation: "DeleteGps";
      group: GpsTagGroup;
    };

export interface BulkMetadataDraftPreview {
  fileCount: number;
  affectedFileCount: number;
  noOpFileCount: number;
  existingOccurrencesSet: number;
  newPropertiesSet: number;
  existingOccurrencesDeleted: number;
  stagedCreationsCancelled: number;
  draftsCleared: number;
}

export interface BulkMetadataDraftPlan {
  preview: BulkMetadataDraftPreview;
}
