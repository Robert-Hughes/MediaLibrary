/// <reference lib="WebWorker" />
/**
 * Thin Worker shell around `SearchIndex`.  All search logic lives in the
 * pure index module — this file only translates postMessage payloads into
 * method calls and posts results back.
 *
 * Spawned from `useSearchWorker` via:
 *   new Worker(new URL("./searchWorker.ts", import.meta.url), { type: "module" })
 *
 * Vite handles bundling; tests bypass this file entirely by exercising
 * `SearchIndex` directly.
 */
import { SearchIndex } from "../search/searchIndex";
import type {
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "./searchWorkerProtocol";

declare const self: DedicatedWorkerGlobalScope;

const index = new SearchIndex();

function post(msg: SearchWorkerOutbound) {
  self.postMessage(msg);
}

self.onmessage = (event: MessageEvent<SearchWorkerInbound>) => {
  const msg = event.data;
  switch (msg.type) {
    case "CLEAR":
      index.clear();
      return;
    case "INIT_PHOTOS":
      for (const p of msg.photos) index.setPhoto(p);
      return;
    case "INIT_META":
      index.setSchemaLabels(msg.schemaLabels);
      for (const e of msg.entries) index.setMeta(e.path, e.meta);
      return;
    case "INIT_DRAFTS":
      index.setSchemaLabels(msg.schemaLabels);
      for (const e of msg.entries) index.setDrafts(e.path, e.edits);
      return;
    case "INIT_TARGET_DRAFT_PATHS":
      for (const path of msg.paths) index.setTargetDraftPresence(path, true);
      return;
    case "UPSERT_PHOTO":
      index.setPhoto(msg.photo);
      return;
    case "UPSERT_META":
      index.setSchemaLabels(msg.schemaLabels);
      index.setMeta(msg.path, msg.meta);
      return;
    case "UPSERT_DRAFTS":
      index.setSchemaLabels(msg.schemaLabels);
      index.setDrafts(msg.path, msg.edits);
      return;
    case "UPSERT_TARGET_DRAFT":
      index.setTargetDraftPresence(msg.path, msg.hasEdits);
      return;
    case "DELETE_PATH":
      index.deletePath(msg.path);
      return;
    case "QUERY": {
      const r = index.query(msg.query);
      post({
        type: "RESULT",
        id: msg.id,
        matched: r.matched,
        hasEditsFilter: r.hasEditsFilter,
      });
      return;
    }
  }
};
