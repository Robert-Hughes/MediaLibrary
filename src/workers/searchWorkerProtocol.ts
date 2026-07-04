/**
 * Wire types shared between the main thread (`useSearchWorker`) and the
 * search worker.  Importing this file is safe from both sides — it contains
 * only `type` / `interface` declarations.
 */
import type { DraftEdit, ImageMetadataState } from "../types";
import type { SearchPhotoFields } from "../search/searchIndex";

// ── Main → worker ────────────────────────────────────────────────────────

export type SearchWorkerInbound =
  | { type: "CLEAR" }
  | { type: "INIT_PHOTOS"; photos: SearchPhotoFields[] }
  | {
      type: "INIT_META";
      entries: Array<{ path: string; meta: ImageMetadataState }>;
    }
  | {
      type: "INIT_DRAFTS";
      entries: Array<{ path: string; edits: Record<string, DraftEdit> }>;
    }
  | { type: "UPSERT_PHOTO"; photo: SearchPhotoFields }
  | { type: "UPSERT_META"; path: string; meta: ImageMetadataState }
  | {
      type: "UPSERT_DRAFTS";
      path: string;
      edits: Record<string, DraftEdit> | undefined;
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
