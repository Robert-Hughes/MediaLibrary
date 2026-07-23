// ── Generated wire-shape types ────────────────────────────────────────────────
//
// These are re-exports of types generated from Rust by ts-rs (see
// docs/GENERATED_TYPES.md). Do not hand-edit the originals in
// `src/types/generated/`; regenerate with:
// cargo test --manifest-path src-tauri/Cargo.toml

import type { PhotoInfo } from "./types/generated/PhotoInfo";
import type { MetadataValue } from "./types/generated/MetadataValue";
import type { SchemaDefinitionId } from "./types/generated/SchemaDefinitionId";
import type { MetadataOccurrences } from "./types/generated/MetadataOccurrences";
import type { ImageMetadata } from "./types/generated/ImageMetadata";
import { KNOWN_METADATA_IDS as ID } from "./metadata/knownIds";
import type {
  TargetDraftEditsByFile,
  TargetDraftEditsStore,
} from "./targetDraftEdits";
import type { TargetApplyControllerState } from "./targetApplyController";
import type { TargetVerifyOutcomesByFile } from "./targetVerifyOutcomes";
import type { TargetVerifyOutcomesStore } from "./targetVerifyOutcomesStore";

export type { PhotoInfo };
export type { MetadataValue } from "./types/generated/MetadataValue";
export type { SchemaDefinitionId } from "./types/generated/SchemaDefinitionId";
export type { MetadataOccurrenceId } from "./types/generated/MetadataOccurrenceId";
export type { RuntimeTagIdScope } from "./types/generated/RuntimeTagIdScope";
export type { MetadataObservedSelector } from "./types/generated/MetadataObservedSelector";
export type { MetadataWriteTarget } from "./types/generated/MetadataWriteTarget";
export type { MetadataOccurrence } from "./types/generated/MetadataOccurrence";
export type { MetadataOccurrences } from "./types/generated/MetadataOccurrences";
export type { MetadataDraftTarget } from "./types/generated/MetadataDraftTarget";
export type { MetadataDraftReconciliation } from "./types/generated/MetadataDraftReconciliation";
export type { MetadataTargetOutcome } from "./types/generated/MetadataTargetOutcome";
export type { SchemaMetadataEdit } from "./types/generated/SchemaMetadataEdit";
export type { MetadataTargetDraftEntry } from "./types/generated/MetadataTargetDraftEntry";
export type { MetadataDraftEdit } from "./types/generated/MetadataDraftEdit";
export type { DateValue } from "./types/generated/DateValue";
export type { TimeValue } from "./types/generated/TimeValue";
export type { DateTimeValue } from "./types/generated/DateTimeValue";
export type { UtcOffsetValue } from "./types/generated/UtcOffsetValue";
export type { OffsetSign } from "./types/generated/OffsetSign";
export type { ListKind } from "./types/generated/ListKind";
export type { RationalValue } from "./types/generated/RationalValue";
export type { TagInfo } from "./types/generated/TagInfo";
export type { TagKind } from "./types/generated/TagKind";
export type { EnumOption } from "./types/generated/EnumOption";
export type { EnumRepr } from "./types/generated/EnumRepr";
export type { EditIntent } from "./types/generated/EditIntent";
export type { ImageMetadata } from "./types/generated/ImageMetadata";
export type { MetadataApplyFileResult } from "./types/generated/MetadataApplyFileResult";
export type { MetadataApplyResult } from "./types/generated/MetadataApplyResult";
export type { MetadataApplyStartedPayload } from "./types/generated/MetadataApplyStartedPayload";
export type { MetadataApplyProgressPayload } from "./types/generated/MetadataApplyProgressPayload";
export type { BatchFailureKind } from "./types/generated/BatchFailureKind";
import type { BatchFailureKind } from "./types/generated/BatchFailureKind";
export type BatchJobFailureKind = BatchFailureKind | "draft_stage_failed";

// ── Metadata normalisation (see docs/NORMALISE_METADATA_PLAN.md) ─────────────
export type { NormaliseGroup } from "./types/generated/NormaliseGroup";
import type { NormaliseGroup } from "./types/generated/NormaliseGroup";
export type { NormaliseRequestItem } from "./types/generated/NormaliseRequestItem";
export type { GroupInputs as NormaliseGroupInputs } from "./types/generated/GroupInputs";
export type { KeywordsInput } from "./types/generated/KeywordsInput";
export type { CreatorInput } from "./types/generated/CreatorInput";
export type { CopyrightInput } from "./types/generated/CopyrightInput";
export type { HeadlineInput } from "./types/generated/HeadlineInput";
export type { TitleInput } from "./types/generated/TitleInput";
export type { LocationInput } from "./types/generated/LocationInput";
export type { DatesInput } from "./types/generated/DatesInput";
export type { DescriptionInput } from "./types/generated/DescriptionInput";
export type { LocationContext } from "./types/generated/LocationContext";
export type { PerImageStats as NormalisePerImageStats } from "./types/generated/PerImageStats";
export type { PerGroupStats as NormalisePerGroupStats } from "./types/generated/PerGroupStats";
export type { NormaliseSummary } from "./types/generated/NormaliseSummary";

// ── Thumbnail store ───────────────────────────────────────────────────────────

export type ThumbnailState = "loading" | "failed" | string;

/**
 * Observable store for thumbnail data, keyed by relative_path.
 * Lives outside React state so thumbnail_ready events update only the
 * individual row that changed, not the entire photo list.
 */
export class ThumbnailStore {
  private data = new Map<string, ThumbnailState>();
  private subscribers = new Map<string, Set<() => void>>();

  reset(paths: string[]) {
    this.data.clear();
    this.subscribers.clear();
    for (const p of paths) this.data.set(p, "loading");
  }

  add(path: string) {
    if (!this.data.has(path)) this.data.set(path, "loading");
  }

  set(path: string, value: ThumbnailState) {
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((cb) => cb());
  }

  get(path: string): ThumbnailState {
    return this.data.get(path) ?? "loading";
  }

  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => {
      const set = this.subscribers.get(path);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) this.subscribers.delete(path);
    };
  }

  getSnapshot(path: string): () => ThumbnailState {
    return () => this.get(path);
  }
}

// ── Authoritative metadata occurrence store ──────────────────────────────────

/**
 * One schema-level value in a pure derived read-only view. This shape remains
 * useful to schema-oriented UI helpers, but it is never scanner wire data or
 * authoritative occurrence state and must not be used to select an occurrence.
 */
export type ImageMetadataEntry = MetadataValue & {
  readonly id: import("./types/generated/SchemaDefinitionId").SchemaDefinitionId;
};

export type ImageMetadataOccurrencesState = "loading" | MetadataOccurrences;
export type ImageMetadataOccurrencesListener = (
  path: string,
  value: ImageMetadataOccurrencesState,
) => void;

/** Observable authoritative occurrence collection keyed by file-relative path. */
export class ImageMetadataOccurrencesStore {
  private data = new Map<string, ImageMetadataOccurrencesState>();
  private subscribers = new Map<string, Set<() => void>>();
  private globalSubscribers = new Set<ImageMetadataOccurrencesListener>();

  add(path: string): void {
    if (this.data.has(path)) return;
    this.data.set(path, "loading");
    this.globalSubscribers.forEach((callback) => callback(path, "loading"));
  }

  set(path: string, value: ImageMetadataOccurrencesState): void {
    if (Object.is(this.data.get(path), value)) return;
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((callback) => callback());
    this.globalSubscribers.forEach((callback) => callback(path, value));
  }

  /** Mark a file's occurrence collection unavailable without claiming it is empty. */
  invalidate(path: string): void {
    if (this.data.get(path) === "loading") return;
    this.data.set(path, "loading");
    this.subscribers.get(path)?.forEach((callback) => callback());
    this.globalSubscribers.forEach((callback) => callback(path, "loading"));
  }

  get(path: string): ImageMetadataOccurrencesState {
    return this.data.get(path) ?? "loading";
  }

  /** Clear folder-owned data while preserving controller/store identity. */
  clear(): void {
    const paths = Array.from(this.data.keys());
    if (paths.length === 0) return;
    this.data.clear();
    for (const path of paths) {
      this.subscribers.get(path)?.forEach((callback) => callback());
      this.globalSubscribers.forEach((callback) => callback(path, "loading"));
    }
  }

  entries(): IterableIterator<[string, ImageMetadataOccurrencesState]> {
    return this.data.entries();
  }

  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => {
      const callbacks = this.subscribers.get(path);
      if (!callbacks) return;
      callbacks.delete(callback);
      if (callbacks.size === 0) this.subscribers.delete(path);
    };
  }

  /** Subscribe to every changed path for cross-cutting incremental consumers. */
  subscribeAll(callback: ImageMetadataOccurrencesListener): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  getSnapshot(path: string): () => ImageMetadataOccurrencesState {
    return () => this.get(path);
  }
}

// ── Metadata Progress store ───────────────────────────────────────────────────

/**
 * Observable store for tracking metadata loading progress.
 * Separate from React state to avoid triggering re-renders of the entire component tree.
 */
export class MetadataProgressStore {
  private totalPhotos = 0;
  private receivedCount = 0;
  private subscribers = new Set<() => void>();

  reset() {
    this.totalPhotos = 0;
    this.receivedCount = 0;
    this.notifySubscribers();
  }

  setTotal(total: number) {
    this.totalPhotos = total;
    this.notifySubscribers();
  }

  incrementReceived(count: number = 1) {
    this.receivedCount += count;
    this.notifySubscribers();
  }

  getRemaining(): number {
    return Math.max(0, this.totalPhotos - this.receivedCount);
  }

  getTotal(): number {
    return this.totalPhotos;
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getSnapshot(): () => number {
    return () => this.getRemaining();
  }

  getTotalSnapshot(): () => number {
    return () => this.totalPhotos;
  }

  private notifySubscribers() {
    // Use queueMicrotask to defer notifications until after the current render
    queueMicrotask(() => {
      this.subscribers.forEach((cb) => cb());
    });
  }
}

// ── Columns ───────────────────────────────────────────────────────────────────

export type OsColumnKey = "date_modified" | "date_created";
export type VisibleColumn =
  { kind: "os"; key: OsColumnKey } | { kind: "image"; id: SchemaDefinitionId };

// ── Sorting ───────────────────────────────────────────────────────────────────

export type SortDirection = "asc" | "desc";
export type SortKey =
  | { kind: "path"; direction: SortDirection }
  | { kind: "os"; key: OsColumnKey; direction: SortDirection }
  | { kind: "image"; id: SchemaDefinitionId; direction: SortDirection };

export interface SortConfig {
  primary: SortKey | null;
  secondary: SortKey | null;
}

/** Deep structural equality for semantic `MetadataValue` entries. */
export function metadataValueEqual(
  a: MetadataValue | undefined,
  b: MetadataValue | undefined,
): boolean {
  const av = metadataEntryToComparableValue(a);
  const bv = metadataEntryToComparableValue(b);
  return deepEqual(av, bv);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const ka = Object.keys(left);
    const kb = Object.keys(right);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in right)) return false;
      if (!deepEqual(left[k], right[k])) return false;
    }
    return true;
  }
  return false;
}

function metadataEntryToComparableValue(
  value: MetadataValue | undefined,
): unknown {
  if (!value) return undefined;
  switch (value.kind) {
    case "Null":
      return null;
    case "Text":
    case "Bool":
    case "Integer":
    case "Real":
      return value.value;
    case "Rational":
      return value.value.denominator === 0
        ? null
        : value.value.numerator / value.value.denominator;
    case "List": {
      const items = value.value.items.map(
        (item) => metadataEntryToComparableValue(item) ?? null,
      );
      if (value.value.list_kind === "Bag") {
        return {
          bag: items
            .map((item) => ({ item, token: stableComparableToken(item) }))
            .sort((left, right) => left.token.localeCompare(right.token))
            .map(({ item }) => item),
        };
      }
      return { [value.value.list_kind]: items };
    }
    case "Struct":
      return Object.fromEntries(
        Object.entries(value.value).map(([k, v]) => [
          k,
          metadataEntryToComparableValue(v),
        ]),
      );
    default:
      return JSON.stringify(value);
  }
}

function stableComparableToken(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableComparableToken).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${stableComparableToken(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── App state ─────────────────────────────────────────────────────────────────

export type TargetDraftPersistenceState =
  { status: "ready" } | { status: "load-failed"; error: string };

export type AppState =
  | { kind: "idle" }
  | {
      kind: "loading";
      folder: string;
      visibleColumns: VisibleColumn[];
      columnWidths: Record<string, number>;
      sortConfig: SortConfig;
    }
  | {
      kind: "loaded";
      folder: string;
      photos: PhotoInfo[];
      thumbnails: ThumbnailStore;
      imageMetadataOccurrences: ImageMetadataOccurrencesStore;
      metadataProgress: MetadataProgressStore;
      scanning: boolean; // true while the directory walk is still running
      galleryIndex: number | null;
      selectedIndex: number | null;

      // Unified, ordered list of metadata columns (mix of OS and image kinds)
      visibleColumns: VisibleColumn[];

      // Column widths (pixels); absent key means use CSS default
      columnWidths: Record<string, number>;

      // Sorting
      sortConfig: SortConfig;
      metadataVersion: number; // Incremented when a metadata batch lands; invalidates sort useMemo

      // Application errors and warnings
      applicationErrors: ApplicationErrorPayload[];

      // Exact target-aware metadata drafts.
      targetDraftEdits: TargetDraftEditsByFile;
      targetDraftEditsStore: TargetDraftEditsStore;
      targetDraftPersistence: TargetDraftPersistenceState;
      targetApplying: TargetApplyControllerState;

      // Apply-edits in-flight state (non-null while metadata apply is running)
      applying: ApplyEditsInFlight | null;

      /** Exact-target verification outcomes that still need user attention. */
      targetVerifyOutcomes: TargetVerifyOutcomesByFile;
      targetVerifyOutcomesStore: TargetVerifyOutcomesStore;
    };

export interface ApplyEditsInFlight {
  total: number;
  current: number;
  /** File currently being processed (most recent progress event), if any. */
  currentFile: string | null;
  failureCount: number;
  cancelling: boolean;
}

// ── AI image-description (see docs/IMAGE_ANALYSIS.md) ──────────────────────────

export type DescribePhase =
  "estimating" | "awaiting-confirm" | "running" | "done";

export interface DescribeEstimate {
  totalInputTokens: number;
  predictedCostUsd: number;
  upperBoundCostUsd: number;
  model: string;
  estimateMode?: "heuristic" | "exact";
}

/**
 * Per-group outcome counts collected during the estimate walk. The
 * estimate now walks every group regardless of user selection so the
 * confirm-phase dialog can show a per-group outcome table; the user's
 * selection is honoured client-side (cost recomputed from
 * `aiTokenBreakdown` + `pricing`, drafts produced by the run command).
 */
export interface NormaliseGroupOutcomeCounts {
  nNoop: number;
  nNormalisedDeterministic: number;
  nNormalisedAi: number;
  nConflict: number;
  /**
   * Sum across all images of the count of target fields that have a
   * non-empty current effective value and would be replaced by a
   * different value (or removed). For AI-fired groups the eventual
   * value isn't known up-front, so the count assumes "always
   * different".
   */
  nOverwrites: number;
}

export interface NormaliseEstimateAiTokenBreakdown {
  descriptionInputTokens: number;
  titleInputTokens: number;
  descriptionCallCount: number;
  titleCallCount: number;
}

export interface NormaliseEstimatePricing {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Cost-estimate summary for the metadata-normaliser.
 *
 * `model` is the empty string and `pricing` / `aiTokenBreakdown` are
 * `null` when no preflight ran (missing API key, or no pricing entry
 * for the configured model). `perGroupOutcomes` is always populated
 * because the outcome walk never needs the API.
 */
export interface NormaliseEstimate {
  nImagesWithAiB: number;
  nImagesWithAiC: number;
  nImagesNoAi: number;
  totalInputTokens: number;
  predictedCostUsd: number;
  upperBoundCostUsd: number;
  model: string;
  perGroupOutcomes: Partial<
    Record<NormaliseGroup, NormaliseGroupOutcomeCounts>
  >;
  aiTokenBreakdown: NormaliseEstimateAiTokenBreakdown | null;
  pricing: NormaliseEstimatePricing | null;
  expectedOutPerCallB: number;
  maxOutPerCallB: number;
  expectedOutPerCallC: number;
  maxOutPerCallC: number;
}

export interface DescribeFailure {
  relativePath: string;
  kind: BatchJobFailureKind;
  detail: string;
}

export interface DescribeUsageSummary {
  totalInputTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalNonReasoningOutputTokens: number;
  serviceTier: string;
  reasoningEffort: string;
  predictedCostUsd: number;
  actualCostUsd: number;
}

/**
 * UI state machine for the AI-description flow. Single object covers all
 * four phases; the dialog reads `phase` and renders the matching panel.
 * Mirrors `ApplyEditsInFlight` in spirit but adds estimate + result fields.
 */
export interface DescribeProgressState {
  phase: DescribePhase;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: DescribeFailure[];
  succeeded: string[];
  estimate: DescribeEstimate | null;
  estimateError: string | null;
  usageSummary: DescribeUsageSummary | null;
  /** Original rel-paths the dialog was opened for — needed for confirm step. */
  relPaths: string[];
}

// ── Reverse-geocoding (see docs/REVERSE_GEOCODE_PLAN.md) ──────────────────────

/**
 * Industry-standard location tag keys written by the reverse-geocode
 * flow. Each XMP key has a paired IPTC IIM mirror; both are written
 * together so the legacy mirror stays in lockstep with the XMP source
 * of truth. See plan §1 for rationale on the choice of these specific
 * keys (Lightroom / Bridge / Photo Mechanic / digiKam all use them).
 *
 * Used by:
 *  - the "already has location data" overwrite-warning check in
 *    DetailsPane and PhotoList (any of these keys present in metadata
 *    or drafts triggers the warning),
 *  - tests that verify all ten keys land as drafts on success.
 */
/**
 * Per-group target tags written by the metadata normaliser (plan §1).
 * Used by the "already has data" overwrite-warning check in DetailsPane
 * and PhotoList: any of the enabled groups' tags present in metadata or
 * drafts triggers the warning. Keep in sync with the `*_TARGET_TAGS`
 * constants in `src-tauri/src/normalise.rs`.
 */
export const NORMALISE_TARGET_TAGS_BY_GROUP: Record<
  NormaliseGroup,
  readonly SchemaDefinitionId[]
> = {
  keywords: [ID.xmpHierarchicalSubject, ID.xmpSubject, ID.iptcKeywords],
  description: [ID.xmpDescription, ID.imageDescription, ID.iptcCaption],
  title: [ID.xmpTitle, ID.iptcObjectName],
  headline: [ID.xmpHeadline, ID.iptcHeadline],
  creator: [ID.xmpCreator, ID.artist, ID.iptcByLine],
  copyright: [ID.xmpRights, ID.copyright, ID.iptcCopyright],
  location: [
    ID.xmpLocation,
    ID.iptcSubLocation,
    ID.xmpCity,
    ID.iptcCity,
    ID.xmpState,
    ID.iptcProvinceState,
    ID.xmpCountry,
    ID.iptcCountryName,
    ID.xmpCountryCode,
    ID.iptcCountryCode,
  ],
  dates: [
    ID.dateTimeOriginal,
    ID.xmpDateCreated,
    ID.iptcDateCreated,
    ID.iptcTimeCreated,
    ID.createDate,
    ID.xmpCreateDate,
    ID.iptcDigitalCreationDate,
    ID.iptcDigitalCreationTime,
  ],
};

/**
 * Every NormaliseGroup the v1 dialog exposes, in the pass order
 * documented in docs/NORMALISE_METADATA_PLAN.md §2. Used as the default
 * "all enabled" set when a normalise flow is kicked off, and as the
 * canonical ordering for the dialog's per-group toggles.
 */
export const ALL_NORMALISE_GROUPS: readonly NormaliseGroup[] = [
  // Mirrors NormaliseGroup::ALL in the backend (plan §2 pass order).
  // Order matters in the UI too — earlier groups can feed later ones
  // (e.g. Description's canonical feeds Title's AI prompt), so the
  // confirm-table and post-run summary read top-to-bottom in the same
  // order the engine actually walks.
  "keywords",
  "creator",
  "copyright",
  "location",
  "dates",
  "description",
  "title",
  "headline",
];

export const GEOCODE_TARGET_TAGS: readonly SchemaDefinitionId[] = [
  ID.xmpLocation,
  ID.xmpCity,
  ID.xmpState,
  ID.xmpCountry,
  ID.xmpCountryCode,
  ID.iptcSubLocation,
  ID.iptcCity,
  ID.iptcProvinceState,
  ID.iptcCountryName,
  ID.iptcCountryCode,
] as const;

export type GeocodePhase = "awaiting-confirm" | "running" | "done";

/** One item in the geocode_images_cmd invocation. */
export interface GeocodeRequestItem {
  relPath: string;
  /** Decimal degrees; null when the image has no GPS. */
  lat: number | null;
  lon: number | null;
}

export interface GeocodeFailure {
  relativePath: string;
  kind: BatchJobFailureKind;
  detail: string;
}

/**
 * Per-source counters returned in the geocode_complete payload. Each
 * field is the count of images that reached that final outcome — they
 * sum to the batch total (no_gps is mutually exclusive with failed in
 * the sense that no_gps images are counted only in n_no_gps).
 */
export interface GeocodeSummary {
  nSucceededFromNominatim: number;
  nSucceededFromCache: number;
  nSucceededFromOverpass: number;
  nNoGps: number;
  nFailed: number;
}

export interface GeocodeProgressState {
  phase: GeocodePhase;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: GeocodeFailure[];
  succeeded: string[];
  summary: GeocodeSummary | null;
  /** Original items the dialog was opened for. */
  items: GeocodeRequestItem[];
}

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface PhotoFoundPayload {
  scan_id: number;
  photos: PhotoInfo[];
}

export interface ImageMetadataReadyPayload {
  scan_id: number;
  results: ImageMetadata[];
}

export interface ThumbnailReadyPayload {
  scan_id: number;
  results: { relative_path: string; thumbnail: string | null }[];
}

export interface ScanErrorPayload {
  scan_id: number;
  message: string;
}

export interface ApplicationErrorPayload {
  scan_id: number;
  severity: "error" | "warning";
  error_type: string;
  error_message: string;
  affected_files: string[];
}
