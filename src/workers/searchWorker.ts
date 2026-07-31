/// <reference lib="WebWorker" />
/** Thin Worker shell around the pure incremental SearchIndex. */
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
      for (const file of msg.files) index.setFile(file);
      return;
    case "INIT_OCCURRENCES":
      index.setSchemaLabels(msg.schemaLabels);
      for (const entry of msg.entries) {
        index.setOccurrences(entry.path, entry.occurrences);
      }
      return;
    case "INIT_DRAFTS":
      index.setSchemaLabels(msg.schemaLabels);
      for (const entry of msg.entries) index.setDrafts(entry.path, entry.edits);
      return;
    case "UPSERT_PHOTO":
      index.setFile(msg.file);
      return;
    case "UPSERT_OCCURRENCES":
      index.setSchemaLabels(msg.schemaLabels);
      index.setOccurrences(msg.path, msg.occurrences);
      return;
    case "UPSERT_OCCURRENCES_BATCH":
      index.setSchemaLabels(msg.schemaLabels);
      for (const path of msg.deletedPaths) index.deletePath(path);
      for (const entry of msg.entries) {
        index.setOccurrences(entry.path, entry.occurrences);
      }
      return;
    case "UPSERT_DRAFTS":
      index.setSchemaLabels(msg.schemaLabels);
      index.setDrafts(msg.path, msg.edits);
      return;
    case "UPSERT_DRAFTS_BATCH":
      index.setSchemaLabels(msg.schemaLabels);
      for (const entry of msg.entries) index.setDrafts(entry.path, entry.edits);
      return;
    case "DELETE_PATH":
      index.deletePath(msg.path);
      return;
    case "QUERY": {
      const result = index.query(msg.query);
      post({
        type: "RESULT",
        id: msg.id,
        matched: result.matched,
        hasEditsFilter: result.hasEditsFilter,
      });
      return;
    }
  }
};
