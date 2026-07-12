/**
 * Pure, framework-free search index for the list view.  Owns per-path
 * haystacks built from photo fields + image metadata + draft edits, and
 * answers substring queries with a single-step prefix-narrowing cache.
 *
 * Lives in its own module so it can be unit-tested directly (without a
 * Worker harness) and reused as the body of `src/workers/searchWorker.ts`.
 */
import type {
  SearchDraftEntry,
  SearchMetadataState,
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
  /** Paths that match, in arbitrary order. */
  matched: string[];
  hasEditsFilter: boolean;
}

const HAS_EDITS_TOKEN = "has:edits";

function photoChunk(fields: SearchPhotoFields): string {
  return [
    fields.relative_path,
    fields.filename,
    formatPhotoRowDate(fields.date_modified),
    formatPhotoRowDate(fields.date_created),
  ].join("\n");
}

function exactIdChunk(id: SearchMetadataEntryId): string[] {
  return [
    id.table,
    id.tag_id,
    ...(id.index === undefined ? [] : [String(id.index)]),
    formatSchemaDefinitionIdForDiagnostics(id),
  ];
}

type SearchMetadataEntryId = SearchSchemaLabel["id"];

function labelChunk(
  id: SearchMetadataEntryId,
  labels: Map<string, SearchSchemaLabel>,
): string[] {
  const label = labels.get(schemaDefinitionIdToken(id));
  return label
    ? [`${label.group}:${label.name}`, label.name, label.description ?? ""]
    : [];
}

function metaChunk(
  meta: SearchMetadataState | undefined,
  labels: Map<string, SearchSchemaLabel>,
): string {
  if (!meta || meta === "loading") return "";
  const parts: string[] = [];
  for (const entry of meta) {
    parts.push(
      ...labelChunk(entry.id, labels),
      ...exactIdChunk(entry.id),
      metadataEntryToDisplayString(entry.value),
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
  private metadata = new Map<string, SearchMetadataState>();
  /** Kept raw so `has:edits` can answer without re-parsing the haystack. */
  private drafts = new Map<string, SearchDraftEntry[]>();
  private schemaLabels = new Map<string, SearchSchemaLabel>();
  /** Pre-lowercased combined haystack, the substring search target. */
  private haystacks = new Map<string, string>();

  /**
   * One-step prefix cache.  Any mutation invalidates it because the
   * underlying haystack set may have changed.  We retain it across pure
   * query→query calls so typing "foo" → "foob" narrows from prior results.
   */
  private priorQuery: { norm: string; matched: string[] } | null = null;

  // ── Ingest ────────────────────────────────────────────────────────────

  setPhoto(fields: SearchPhotoFields) {
    this.photoFields.set(fields.relative_path, fields);
    this.rebuild(fields.relative_path);
  }

  setMeta(
    path: string,
    meta: SearchMetadataState | undefined,
    schemaLabels: readonly SearchSchemaLabel[] = [],
  ) {
    this.storeLabels(schemaLabels);
    if (meta === undefined) {
      this.metadata.delete(path);
    } else {
      this.metadata.set(path, meta);
    }
    this.rebuild(path);
  }

  setDrafts(
    path: string,
    edits: SearchDraftEntry[] | undefined,
    schemaLabels: readonly SearchSchemaLabel[] = [],
  ) {
    this.storeLabels(schemaLabels);
    if (edits === undefined || edits.length === 0) {
      this.drafts.delete(path);
    } else {
      this.drafts.set(path, edits);
    }
    this.rebuild(path);
  }

  deletePath(path: string) {
    this.photoFields.delete(path);
    this.metadata.delete(path);
    this.drafts.delete(path);
    this.haystacks.delete(path);
    this.priorQuery = null;
  }

  /** Drop everything.  Used on scan reset. */
  clear() {
    this.photoFields.clear();
    this.metadata.clear();
    this.drafts.clear();
    this.schemaLabels.clear();
    this.haystacks.clear();
    this.priorQuery = null;
  }

  /** Number of indexed photos.  Mainly for tests / diagnostics. */
  size(): number {
    return this.photoFields.size;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  query(rawQuery: string): SearchQueryResult {
    let q = rawQuery.trim().toLowerCase();
    const hasEditsFilter = q.includes(HAS_EDITS_TOKEN);
    if (hasEditsFilter) {
      q = q.replace(HAS_EDITS_TOKEN, "").trim();
    }

    if (!q && !hasEditsFilter) {
      const matched = Array.from(this.photoFields.keys());
      this.priorQuery = { norm: "", matched };
      return { matched, hasEditsFilter: false };
    }

    // Prefix narrowing: when the new query strictly extends the prior one
    // (and the prior was also a plain substring query), restrict the
    // candidate set to the prior matches.  `has:edits` flips the filter
    // semantic so we don't reuse a cache produced with the opposite flag.
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
      const hay = this.haystacks.get(path);
      if (hay && hay.includes(q)) matched.push(path);
    }

    // Only cache plain substring queries — `has:edits` interacts with the
    // separate drafts map, so re-narrowing under a different filter would
    // be unsound.
    this.priorQuery = hasEditsFilter ? null : { norm: q, matched };
    return { matched, hasEditsFilter };
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private rebuild(path: string) {
    const fields = this.photoFields.get(path);
    if (!fields) {
      this.haystacks.delete(path);
      this.priorQuery = null;
      return;
    }
    const combined = [
      photoChunk(fields),
      metaChunk(this.metadata.get(path), this.schemaLabels),
      draftsChunk(this.drafts.get(path), this.schemaLabels),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    this.haystacks.set(path, combined);
    this.priorQuery = null;
  }

  private storeLabels(labels: readonly SearchSchemaLabel[]) {
    for (const label of labels) {
      this.schemaLabels.set(schemaDefinitionIdToken(label.id), label);
    }
  }
}
