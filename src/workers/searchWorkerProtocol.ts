/**
 * Wire types shared between the main thread (`useSearchWorker`) and the search
 * worker. Importing this file is safe from both sides.
 */
import type {
  MetadataDraftEdit,
  MetadataOccurrenceId,
  MetadataValue,
  SchemaDefinitionId,
  TagKind,
} from "../types";
import type { SearchFileFields } from "../search/searchIndex";

export interface SearchSchemaLabel {
  id: SchemaDefinitionId;
  group: string;
  name: string;
  description: string | null;
  kind: TagKind;
}

export interface SearchOccurrenceEntry {
  schemaId: SchemaDefinitionId;
  value: MetadataValue;
  occurrenceId: MetadataOccurrenceId;
}

export type SearchOccurrencesState = "loading" | SearchOccurrenceEntry[];

export interface SearchDraftEntry {
  id: SchemaDefinitionId;
  edit: MetadataDraftEdit;
}

export type SearchWorkerInbound =
  | { type: "CLEAR" }
  | { type: "INIT_PHOTOS"; files: SearchFileFields[] }
  | {
      type: "INIT_OCCURRENCES";
      entries: Array<{
        path: string;
        occurrences: SearchOccurrencesState;
      }>;
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
  | { type: "UPSERT_PHOTO"; file: SearchFileFields }
  | {
      type: "UPSERT_OCCURRENCES";
      path: string;
      occurrences: SearchOccurrencesState;
      schemaLabels: SearchSchemaLabel[];
    }
  | {
      type: "UPSERT_OCCURRENCES_BATCH";
      entries: Array<{
        path: string;
        occurrences: SearchOccurrencesState;
      }>;
      deletedPaths: string[];
      schemaLabels: SearchSchemaLabel[];
    }
  | {
      type: "UPSERT_DRAFTS";
      path: string;
      edits: SearchDraftEntry[] | undefined;
      schemaLabels: SearchSchemaLabel[];
    }
  | {
      type: "UPSERT_DRAFTS_BATCH";
      entries: Array<{
        path: string;
        edits: SearchDraftEntry[] | undefined;
      }>;
      schemaLabels: SearchSchemaLabel[];
    }
  | { type: "DELETE_PATH"; path: string }
  | { type: "QUERY"; id: number; query: string };

export type SearchWorkerOutbound = {
  type: "RESULT";
  id: number;
  matched: string[];
  hasEditsFilter: boolean;
};
