/** Pure, framework-free incremental search index for the list view. */
import type {
  SearchDraftEntry,
  SearchOccurrencesState,
  SearchSchemaLabel,
} from "../workers/searchWorkerProtocol";
import {
  displayStringOfMetadataDraft,
  metadataEntryToDisplayString,
} from "../draft";
import { formatPhotoRowDate } from "../utils/photoDate";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";

export interface SearchPhotoFields {
  relative_path: string;
  filename: string;
  date_modified: number | null;
  date_created: number | null;
}

export interface SearchQueryResult {
  matched: string[];
  hasEditsFilter: boolean;
}

const HAS_EDITS_TOKEN = "has:edits";

type SearchSchemaId = SearchSchemaLabel["id"];

function photoChunk(fields: SearchPhotoFields): string {
  return [
    fields.relative_path,
    fields.filename,
    formatPhotoRowDate(fields.date_modified),
    formatPhotoRowDate(fields.date_created),
  ].join("\n");
}

function exactIdChunk(id: SearchSchemaId): string[] {
  return [
    id.table,
    id.tag_id,
    ...(id.index === undefined ? [] : [String(id.index)]),
    formatSchemaDefinitionIdForDiagnostics(id),
  ];
}

function labelChunk(
  id: SearchSchemaId,
  labels: Map<string, SearchSchemaLabel>,
): string[] {
  const label = labels.get(schemaDefinitionIdToken(id));
  return label
    ? [`${label.group}:${label.name}`, label.name, label.description ?? ""]
    : [];
}

function occurrencesChunk(
  occurrences: SearchOccurrencesState | undefined,
  labels: Map<string, SearchSchemaLabel>,
): string {
  if (!occurrences || occurrences === "loading") return "";
  const parts: string[] = [];
  for (const entry of occurrences) {
    parts.push(
      ...labelChunk(entry.schemaId, labels),
      ...exactIdChunk(entry.schemaId),
      metadataEntryToDisplayString(entry.value),
      entry.occurrenceId.document ?? "",
      entry.occurrenceId.path,
      entry.occurrenceId.runtime_tag_id,
      entry.occurrenceId.tag_id_scope.table,
      entry.occurrenceId.tag_id_scope.tag_id,
      entry.occurrenceId.tag_id_scope.index == null
        ? ""
        : String(entry.occurrenceId.tag_id_scope.index),
      String(entry.occurrenceId.copy),
      `document:${entry.occurrenceId.document ?? ""}`,
      `path:${entry.occurrenceId.path}`,
      `runtime-tag:${entry.occurrenceId.runtime_tag_id}`,
      `wrapped-table:${entry.occurrenceId.tag_id_scope.table}`,
      `wrapped-tag:${entry.occurrenceId.tag_id_scope.tag_id}`,
      `wrapped-index:${entry.occurrenceId.tag_id_scope.index ?? ""}`,
      `copy:${entry.occurrenceId.copy}`,
    );
  }
  return parts.join("\n");
}

function draftsChunk(
  edits: SearchDraftEntry[] | undefined,
  labels: Map<string, SearchSchemaLabel>,
): string {
  if (!edits) return "";
  const parts: string[] = [];
  for (const entry of edits) {
    const display = displayStringOfMetadataDraft(entry.edit);
    parts.push(
      ...labelChunk(entry.id, labels),
      ...exactIdChunk(entry.id),
      display === null ? "—" : (display ?? ""),
    );
  }
  return parts.join("\n");
}

export class SearchIndex {
  private photoFields = new Map<string, SearchPhotoFields>();
  private occurrences = new Map<string, SearchOccurrencesState>();
  private drafts = new Map<string, SearchDraftEntry[]>();
  private schemaLabels = new Map<string, SearchSchemaLabel>();
  private haystacks = new Map<string, string>();
  private priorQuery: { norm: string; matched: string[] } | null = null;

  setPhoto(fields: SearchPhotoFields) {
    this.photoFields.set(fields.relative_path, fields);
    this.rebuild(fields.relative_path);
  }

  setSchemaLabels(labels: readonly SearchSchemaLabel[]) {
    for (const label of labels) {
      this.schemaLabels.set(schemaDefinitionIdToken(label.id), label);
    }
  }

  setOccurrences(
    path: string,
    occurrences: SearchOccurrencesState | undefined,
    schemaLabels: readonly SearchSchemaLabel[] = [],
  ) {
    if (schemaLabels.length > 0) this.setSchemaLabels(schemaLabels);
    if (occurrences === undefined) this.occurrences.delete(path);
    else this.occurrences.set(path, occurrences);
    this.rebuild(path);
  }

  setDrafts(
    path: string,
    edits: SearchDraftEntry[] | undefined,
    schemaLabels: readonly SearchSchemaLabel[] = [],
  ) {
    if (schemaLabels.length > 0) this.setSchemaLabels(schemaLabels);
    if (edits === undefined || edits.length === 0) this.drafts.delete(path);
    else this.drafts.set(path, edits);
    this.rebuild(path);
  }

  deletePath(path: string) {
    this.photoFields.delete(path);
    this.occurrences.delete(path);
    this.drafts.delete(path);
    this.haystacks.delete(path);
    this.priorQuery = null;
  }

  clear() {
    this.photoFields.clear();
    this.occurrences.clear();
    this.drafts.clear();
    this.schemaLabels.clear();
    this.haystacks.clear();
    this.priorQuery = null;
  }

  size(): number {
    return this.photoFields.size;
  }

  query(rawQuery: string): SearchQueryResult {
    let q = rawQuery.trim().toLowerCase();
    const hasEditsFilter = q.includes(HAS_EDITS_TOKEN);
    if (hasEditsFilter) q = q.replace(HAS_EDITS_TOKEN, "").trim();

    if (!q && !hasEditsFilter) {
      const matched = Array.from(this.photoFields.keys());
      this.priorQuery = { norm: "", matched };
      return { matched, hasEditsFilter: false };
    }

    const canNarrow =
      this.priorQuery !== null &&
      q.length >= this.priorQuery.norm.length &&
      q.startsWith(this.priorQuery.norm);
    const candidates: Iterable<string> = canNarrow
      ? this.priorQuery!.matched
      : this.photoFields.keys();

    const matched: string[] = [];
    for (const path of candidates) {
      if (hasEditsFilter && !this.drafts.has(path)) continue;
      if (!q) {
        matched.push(path);
        continue;
      }
      const haystack = this.haystacks.get(path);
      if (haystack?.includes(q)) matched.push(path);
    }

    this.priorQuery = hasEditsFilter ? null : { norm: q, matched };
    return { matched, hasEditsFilter };
  }

  private rebuild(path: string) {
    const fields = this.photoFields.get(path);
    if (!fields) {
      this.haystacks.delete(path);
      this.priorQuery = null;
      return;
    }
    const combined = [
      photoChunk(fields),
      occurrencesChunk(this.occurrences.get(path), this.schemaLabels),
      draftsChunk(this.drafts.get(path), this.schemaLabels),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    this.haystacks.set(path, combined);
    this.priorQuery = null;
  }
}
