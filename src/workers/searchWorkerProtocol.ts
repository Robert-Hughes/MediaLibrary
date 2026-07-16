/**
 * Wire types shared between the main thread (`useSearchWorker`) and the
 * search worker.  Importing this file is safe from both sides — it contains
 * only `type` / `interface` declarations.
 */
import type {
  MetadataDraftEdit,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import type { SearchPhotoFields } from "../search/searchIndex";

export interface SearchSchemaLabel {
  id: SchemaDefinitionId;
  group: string;
  name: string;
  description: string | null;
}

export interface SearchMetadataEntry {
  id: SchemaDefinitionId;
  value: MetadataValue;
}

export type SearchMetadataState = "loading" | SearchMetadataEntry[];

export interface SearchDraftEntry {
  id: SchemaDefinitionId;
  edit: MetadataDraftEdit;
}

// ── Main → worker ────────────────────────────────────────────────────────

export type SearchWorkerInbound =
  | { type: "CLEAR" }
  | { type: "INIT_PHOTOS"; photos: SearchPhotoFields[] }
  | {
      type: "INIT_META";
      entries: Array<{ path: string; meta: SearchMetadataState }>;
      schemaLabels: SearchSchemaLabel[];
    }
  | {
      type: "INIT_DRAFTS";
      entries: Array<{
        path: string;
        edits: SearchDraftEntry[];
      }>;
      schemaLabels: SearchSchemaLabel[];
    }
  | { type: "UPSERT_PHOTO"; photo: SearchPhotoFields }
  | {
      type: "UPSERT_META";
      path: string;
      meta: SearchMetadataState;
      schemaLabels: SearchSchemaLabel[];
    }
  | {
      type: "UPSERT_DRAFTS";
      path: string;
      edits: SearchDraftEntry[] | undefined;
      schemaLabels: SearchSchemaLabel[];
    }
  | { type: "DELETE_PATH"; path: string }
  | { type: "QUERY"; id: number; query: string };

// ── Worker → main ────────────────────────────────────────────────────────

export type SearchWorkerOutbound = {
  type: "RESULT";
  id: number;
  matched: string[];
  hasEditsFilter: boolean;
};
