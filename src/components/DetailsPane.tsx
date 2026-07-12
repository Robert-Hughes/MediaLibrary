import { useEffect, useMemo, useState } from "react";
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  PhotoInfo,
  ImageMetadataState,
  ImageMetadataOccurrencesState,
  MetadataDraftCollection,
} from "../types";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { TypedValueEditor } from "./editors/TypedValueEditor";
import { useTagInfo, useTagInfos } from "../hooks/useTagInfo";
import { DatatypeBadge } from "./DatatypeBadge";
import { gpsMemberGroup } from "../metadata/tag_overrides";
import {
  schemaDatatype,
  metadataEntryDatatype,
  metadataValueDatatype,
  datatypesMatch,
} from "../utils/datatype";
import { NewPropertyDialog } from "./NewPropertyDialog";
import type {
  MetadataEntry,
  MetadataOccurrenceDisplayEntry,
} from "../utils/detailsPaneHelpers";
import {
  groupImageMetadata,
  getOsEntries,
  unprojectedResolvedMetadataOccurrences,
} from "../utils/detailsPaneHelpers";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import type { SchemaDefinitionId } from "../types";
import {
  haystackContainsNormalized,
  normalizeListSearchQuery,
} from "../utils/listSearchText";
import {
  confirmApplyEdits,
  confirmDiscardEdits,
  confirmRemoveMetadataGroupFields,
  confirmDiscardMetadataGroupEdits,
} from "../utils/applyDiscardPrompts";
import {
  displayStringOfMetadataDraft,
  metadataValueToDisplayStringForTag,
} from "../draft";
import { GpsMapOverview } from "./GpsMapOverview";
import { resolveGps } from "../utils/resolveGps";
import { buildEffectiveMetadata } from "../utils/buildNormaliseItems";
import {
  metadataGet,
  type MetadataCollection,
} from "../utils/metadataCollection";

interface Props {
  photo: PhotoInfo;
  metadata: ImageMetadataState;
  /** Authoritative occurrences; optional for legacy/direct consumers. */
  occurrences?: ImageMetadataOccurrencesState;
  /**
   * Display-string view of pending edits, keyed by metadata tag.  Each value
   * is the human-readable form of the draft (or `null` for a Delete draft).
   * When absent, the pane derives an equivalent map from `typedDraftEdits`.
   */
  draftEdits?: Record<string, string | null>;
  /** Semantic draft edits, keyed by metadata tag. Primary write path. */
  typedDraftEdits?: MetadataDraftCollection;
  /** Semantic setter used by every editor via the local adapter. */
  onSetMetadataDraft?: (
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ) => void;
  /** Batch setter for paired-tag editors (GPS). */
  onSetMetadataDraftBatch: (
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => void;
  onDiscardDraft?: (id: SchemaDefinitionId) => void;
  onDiscardDraftBatch: (ids: SchemaDefinitionId[]) => void;
  onDiscardAllEdits?: () => void;
  onApplyEdits?: () => void;
  /**
   * Trigger the AI-description flow for this photo. Wired by App so the
   * progress dialog can live at the app level rather than per-pane.
   * Optional so DetailsPane keeps rendering when the parent doesn't wire
   * the feature (e.g. read-only contexts, older tests).
   */
  onGenerateAiDescription?: () => void;
  /**
   * Trigger the reverse-geocoding flow for this image. App-level
   * callback so the geocode progress dialog lives once, not once per
   * pane. Optional so DetailsPane keeps rendering when the parent
   * doesn't wire the feature (e.g. tests, read-only contexts).
   */
  onGeocode?: () => void;
  /**
   * Trigger the metadata-normalisation flow for this image. App-level
   * callback so the normalise progress dialog lives once, not once per
   * pane. Optional so DetailsPane keeps rendering in tests / read-only
   * contexts that don't wire the feature.
   */
  onNormalise?: () => void;
  /**
   * Reveal this photo in the host file manager. Same backend pathway as
   * the list-view context menu's "Show in File Explorer" entry — the
   * App-level callback owns the index/path lookup so DetailsPane stays
   * agnostic about how the photo is addressed.
   */
  onShowInFileExplorer?: () => void;
}

function detailsRowMatchesSearch(
  label: string,
  value: string,
  draftValue: string | null | undefined,
  friendlyName: string,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(
    `${label}\n${value}\n${draftValue ?? ""}\n${friendlyName}`,
    normalizedQuery,
  );
}

/**
 * Split a normalized details-search query into the residual text query
 * and a `has:edits` boolean filter. Returns the bare query (with the
 * `has:edits` token stripped + trimmed) so the standard substring match
 * runs against the user's actual search terms.
 */
function splitHasEditsFilter(normalizedQuery: string): {
  query: string;
  hasEditsFilter: boolean;
} {
  const hasEditsFilter = normalizedQuery.includes("has:edits");
  const query = hasEditsFilter
    ? normalizedQuery.replace("has:edits", "").trim()
    : normalizedQuery;
  return { query, hasEditsFilter };
}

function displayStringOfDraft(
  edit: MetadataDraftEdit | undefined,
): string | null | undefined {
  if (edit === undefined) return undefined;
  return displayStringOfMetadataDraft(edit);
}

function DetailsValueCell({
  originalValue,
  draftValue,
  searchQuery,
  valueBadge,
  draftBadge,
  readOnly,
}: {
  originalValue: string;
  draftValue?: string | null;
  searchQuery: string;
  valueBadge?: { code: string; label: string } | null;
  draftBadge?: { code: string; label: string } | null;
  readOnly?: boolean;
}) {
  return (
    <td
      className={
        readOnly ? "details-value details-value--readonly" : "details-value"
      }
      title={readOnly ? `${originalValue}\n(read-only)` : originalValue}
      data-readonly={readOnly ? "true" : undefined}
    >
      {draftValue !== undefined ? (
        <>
          {originalValue ? (
            <>
              {valueBadge ? (
                <DatatypeBadge
                  code={valueBadge.code}
                  label={valueBadge.label}
                  variant="value"
                />
              ) : null}
              <s className="draft-original" style={{ opacity: 0.6 }}>
                <HighlightedText
                  text={originalValue}
                  searchQuery={searchQuery}
                />
              </s>{" "}
            </>
          ) : null}
          {draftBadge ? (
            <DatatypeBadge
              code={draftBadge.code}
              label={draftBadge.label}
              variant="draft"
            />
          ) : null}
          <strong className="draft-new">
            <HighlightedText
              text={draftValue === null ? "—" : draftValue}
              searchQuery={searchQuery}
            />
          </strong>
        </>
      ) : (
        <>
          {valueBadge ? (
            <DatatypeBadge
              code={valueBadge.code}
              label={valueBadge.label}
              variant="value"
            />
          ) : null}
          <HighlightedText text={originalValue} searchQuery={searchQuery} />
        </>
      )}
    </td>
  );
}

/**
 * One image-metadata row. Owns its `useTagInfo` lookup so each row can
 * independently render schema/value/draft datatype badges. Lifted out of
 * `DetailsPane` because hooks can't run inside `.map()` callbacks.
 */
function DetailsImageRow({
  entry,
  rawValue,
  draftValue,
  typedDraft,
  searchQuery,
  onContextMenu,
}: {
  entry: MetadataEntry;
  rawValue: ImageMetadataEntry | undefined;
  draftValue: string | null | undefined;
  typedDraft: MetadataDraftEdit | undefined;
  searchQuery: string;
  onContextMenu: (e: React.MouseEvent, originalValue: string) => void;
}) {
  const tag = useTagInfo(entry.id);
  const tagInfo = tag !== "loading" ? tag : null;
  const originalValue = metadataValueToDisplayStringForTag(
    entry.id,
    rawValue,
    tagInfo,
  );
  const schemaInfo = tag && tag !== "loading" ? schemaDatatype(tag.kind) : null;
  const readOnly = tag != null && tag !== "loading" && !tag.writable;

  const valueInfo = metadataEntryDatatype(rawValue);
  // With a schema, the value badge is a divergence indicator (hidden when
  // the type matches expectations). Without a schema there is no reference
  // type, so always surface the runtime datatype as informational.
  const showValueBadge =
    valueInfo != null &&
    (schemaInfo == null || !datatypesMatch(valueInfo.code, schemaInfo.code));

  const draftInfo =
    typedDraft && typedDraft.intent !== "Delete"
      ? metadataValueDatatype(typedDraft.value ?? undefined)
      : null;
  const showDraftBadge =
    typedDraft != null &&
    typedDraft.intent !== "Delete" &&
    draftInfo != null &&
    ((valueInfo != null && draftInfo.code !== valueInfo.code) ||
      (schemaInfo != null &&
        !datatypesMatch(draftInfo.code, schemaInfo.code)) ||
      (schemaInfo == null && valueInfo == null));

  return (
    <tr
      key={entry.identityToken}
      className={readOnly ? "details-row details-row--readonly" : "details-row"}
      data-testid="details-row"
      data-row-key={entry.identityToken}
      data-readonly={readOnly ? "true" : undefined}
      onContextMenu={(e) => onContextMenu(e, originalValue)}
    >
      <td
        className="details-key"
        style={
          draftValue !== undefined
            ? { color: "var(--accent-draft)" }
            : undefined
        }
      >
        {schemaInfo ? (
          <DatatypeBadge
            code={schemaInfo.code}
            label={schemaInfo.label}
            variant="schema"
          />
        ) : null}
        <HighlightedText
          text={tagInfo?.name ?? entry.label}
          searchQuery={searchQuery}
        />
      </td>
      <DetailsValueCell
        originalValue={originalValue}
        draftValue={draftValue}
        searchQuery={searchQuery}
        valueBadge={showValueBadge ? valueInfo : null}
        draftBadge={showDraftBadge ? draftInfo : null}
        readOnly={readOnly}
      />
    </tr>
  );
}

function DetailsOccurrenceRow({
  entry,
  searchQuery,
}: {
  entry: MetadataOccurrenceDisplayEntry;
  searchQuery: string;
}) {
  const schemaInfo = schemaDatatype(entry.occurrence.tag_info?.kind);
  const valueInfo = metadataValueDatatype(entry.occurrence.value);
  const showValueBadge =
    valueInfo != null &&
    (schemaInfo == null || !datatypesMatch(valueInfo.code, schemaInfo.code));

  return (
    <tr
      className="details-row details-row--readonly"
      data-testid="details-occurrence-row"
      data-occurrence-token={entry.identityToken}
      data-readonly="true"
      title={entry.originTitle}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <td className="details-key">
        {schemaInfo ? (
          <DatatypeBadge
            code={schemaInfo.code}
            label={schemaInfo.label}
            variant="schema"
          />
        ) : null}
        <HighlightedText text={entry.label} searchQuery={searchQuery} />
        <span className="details-occurrence-origin" title={entry.originTitle}>
          [{entry.origin}]
        </span>
      </td>
      <td
        className="details-value details-value--readonly"
        data-readonly="true"
        title={`${entry.value}\nOccurrence-specific editing is not available yet.`}
      >
        {showValueBadge ? (
          <DatatypeBadge
            code={valueInfo.code}
            label={valueInfo.label}
            variant="value"
          />
        ) : null}
        <HighlightedText text={entry.value} searchQuery={searchQuery} />
      </td>
    </tr>
  );
}

/**
 * Right-click menu for a property row. Lives in its own component so it can
 * call `useTagInfo(contextMenu.key)` — schema lookup decides whether to
 * hide the "Edit…" entry and whether "Remove" should be blocked. Read-only
 * tags expose no editor entry point from the context menu, and cannot be
 * removed since ExifTool refuses delete-writes on read-only tags just like
 * it refuses value-writes.
 */
function DetailsRowContextMenu({
  contextMenu,
  onEdit,
  onEditGps,
  onDiscard,
  onRemove,
  onClose,
}: {
  contextMenu: {
    x: number;
    y: number;
    id: SchemaDefinitionId;
    originalValue: string;
    draftValue?: string | null;
  };
  onEdit: () => void;
  onEditGps?: () => void;
  onDiscard: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const tag = useTagInfo(contextMenu.id);
  const readOnly = tag !== null && tag !== "loading" && !tag.writable;
  const gpsGroup = gpsMemberGroup(contextMenu.id);
  const options = [
    ...(readOnly
      ? []
      : [
          { label: "Edit…", onClick: onEdit },
          ...(gpsGroup && onEditGps
            ? [{ label: "Edit GPS…", onClick: onEditGps }]
            : []),
        ]),
    ...(contextMenu.draftValue !== undefined
      ? [{ label: "Discard edit", onClick: onDiscard }]
      : []),
    ...(readOnly
      ? []
      : [
          {
            label: "Remove",
            onClick: onRemove,
            disabled: false,
            title: undefined as string | undefined,
          },
        ]),
  ];
  // Read-only tag with no draft → no actionable menu items. Bail out via
  // effect (not inline) so we don't setState during render.
  const empty = options.length === 0;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  if (empty) return null;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      options={options}
      onClose={onClose}
    />
  );
}

function DetailsGroupContextMenu({
  contextMenu,
  originalMetadata,
  draftEdits,
  onSetMetadataDraftBatch,
  onDiscardDraftBatch,
  onClose,
}: {
  contextMenu: {
    x: number;
    y: number;
    group: string;
    entries: MetadataEntry[];
  };
  originalMetadata: MetadataCollection | undefined;
  draftEdits: Record<string, string | null>;
  onSetMetadataDraftBatch: (
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => void;
  onDiscardDraftBatch: (ids: SchemaDefinitionId[]) => void;
  onClose: () => void;
}) {
  const group = contextMenu.group;
  const ids = useMemo(
    () => contextMenu.entries.map((e) => e.id),
    [contextMenu.entries],
  );
  const tagInfos = useTagInfos(ids);

  const isLoading = ids.some(
    (id) => tagInfos[schemaDefinitionIdToken(id)] === "loading",
  );

  const removableKeys = useMemo(() => {
    if (isLoading) return [];
    return ids.filter((id) => {
      const tag = tagInfos[schemaDefinitionIdToken(id)];
      return tag === null || (tag !== "loading" && tag.writable);
    });
  }, [ids, tagInfos, isLoading]);

  const draftKeys = useMemo(() => {
    return ids.filter(
      (id) => draftEdits[schemaDefinitionIdToken(id)] !== undefined,
    );
  }, [ids, draftEdits]);

  const removeCount = removableKeys.length;
  const draftCount = draftKeys.length;

  useEffect(() => {
    if (!isLoading && removeCount === 0 && draftCount === 0) {
      onClose();
    }
  }, [isLoading, removeCount, draftCount, onClose]);

  if (isLoading) return null;

  if (removeCount === 0 && draftCount === 0) {
    return null;
  }

  const handleRemove = async () => {
    const confirmed = await confirmRemoveMetadataGroupFields({
      group,
      fieldCount: removeCount,
    });
    if (confirmed) {
      const originalIds = removableKeys.filter(
        (id) =>
          originalMetadata && metadataGet(originalMetadata, id) !== undefined,
      );
      const draftOnlyIds = removableKeys.filter(
        (id) =>
          !originalMetadata || metadataGet(originalMetadata, id) === undefined,
      );

      if (originalIds.length > 0) {
        const deleteEdits = originalIds.map((id) => ({
          id,
          edit: { value: null, intent: "Delete" as const },
        }));
        onSetMetadataDraftBatch(deleteEdits);
      }

      if (draftOnlyIds.length > 0) {
        onDiscardDraftBatch(draftOnlyIds);
      }
    }
    onClose();
  };

  const handleDiscard = async () => {
    const confirmed = await confirmDiscardMetadataGroupEdits({
      group,
      editCount: draftCount,
    });
    if (confirmed) {
      onDiscardDraftBatch(draftKeys);
    }
    onClose();
  };

  function formatRemoveGroupLabel(count: number, group: string): string {
    if (count === 1) {
      return `Remove 1 writable ${group} field…`;
    }
    return `Remove all ${count} writable ${group} fields…`;
  }

  function formatDiscardGroupLabel(count: number, group: string): string {
    if (count === 1) {
      return `Discard 1 ${group} edit…`;
    }
    return `Discard all ${count} ${group} edits…`;
  }

  const options = [
    ...(removeCount > 0
      ? [
          {
            label: formatRemoveGroupLabel(removeCount, group),
            onClick: handleRemove,
          },
        ]
      : []),
    ...(draftCount > 0
      ? [
          {
            label: formatDiscardGroupLabel(draftCount, group),
            onClick: handleDiscard,
          },
        ]
      : []),
  ];

  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      options={options}
      onClose={onClose}
    />
  );
}

export function DetailsPane({
  photo,
  metadata,
  occurrences,
  draftEdits: displayDraftEdits,
  typedDraftEdits,
  onSetMetadataDraft,
  onSetMetadataDraftBatch,
  onDiscardDraft,
  onDiscardDraftBatch,
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onShowInFileExplorer,
}: Props) {
  const [detailsSearch, setDetailsSearch] = useState("");
  const effectiveMetadata = useMemo(
    () =>
      metadata === "loading"
        ? undefined
        : buildEffectiveMetadata(metadata, typedDraftEdits),
    [metadata, typedDraftEdits],
  );
  const resolvedGps = useMemo(() => {
    if (metadata === "loading") return { lat: null, lon: null };
    return resolveGps(typedDraftEdits, metadata);
  }, [typedDraftEdits, metadata]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    id: SchemaDefinitionId;
    originalValue: string;
    draftValue?: string | null;
  } | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number;
    y: number;
    group: string;
  } | null>(null);
  const [editDialog, setEditDialog] = useState<{
    id: SchemaDefinitionId;
    mode: "single" | "gps";
  } | null>(null);
  const [showNewPropertyDialog, setShowNewPropertyDialog] = useState(false);
  // Stage 2 of the new-property flow: key picked, now show a TypedValueEditor
  // for that key.  null when no flow is active or we're still on stage 1.
  const [newPropertyKey, setNewPropertyKey] =
    useState<SchemaDefinitionId | null>(null);

  const draftEdits = useMemo(() => {
    if (displayDraftEdits) return displayDraftEdits;
    if (!typedDraftEdits) return {};
    return Object.fromEntries(
      Object.entries(typedDraftEdits)
        .map(([key, entry]) => [key, displayStringOfDraft(entry.edit)] as const)
        .filter(
          (entry): entry is readonly [string, string | null] =>
            entry[1] !== undefined,
        ),
    );
  }, [displayDraftEdits, typedDraftEdits]);

  const handleContextMenu = (
    e: React.MouseEvent,
    id: SchemaDefinitionId,
    originalValue: string,
    draftValue?: string | null,
  ) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      id,
      originalValue,
      draftValue,
    });
  };
  const normalizedDetailsQuery = useMemo(
    () => normalizeListSearchQuery(detailsSearch),
    [detailsSearch],
  );

  const osEntries = useMemo(() => getOsEntries(photo), [photo]);
  const displayIds = useMemo(() => {
    const ids: SchemaDefinitionId[] = [];
    if (metadata !== "loading") {
      for (const entry of Object.values(metadata)) ids.push(entry.id);
    }
    if (typedDraftEdits) {
      for (const entry of Object.values(typedDraftEdits)) {
        if (entry.edit.intent !== "Delete") ids.push(entry.id);
      }
    }
    return ids;
  }, [metadata, typedDraftEdits]);
  const displayTagInfos = useTagInfos(displayIds);
  const imageGroups = useMemo(() => {
    if (metadata === "loading") return [];

    const combinedMetadata: Record<string, ImageMetadataEntry> = {
      ...metadata,
    };
    if (typedDraftEdits) {
      for (const [key, entry] of Object.entries(typedDraftEdits)) {
        if (entry.edit.intent !== "Delete" && !(key in combinedMetadata)) {
          combinedMetadata[key] = { kind: "Null", id: entry.id };
        }
      }
    }
    return groupImageMetadata(combinedMetadata, displayTagInfos);
  }, [metadata, typedDraftEdits, displayTagInfos]);

  const fullGroupForMenu = useMemo(() => {
    if (!groupContextMenu) return null;
    return imageGroups.find((g) => g.prefix === groupContextMenu.group) ?? null;
  }, [groupContextMenu, imageGroups]);

  const existingMetadataKeys = displayIds;

  const filteredOsEntries = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (!query && !hasEditsFilter) return osEntries;
    return osEntries.filter(([label, value, key]) => {
      if (hasEditsFilter && draftEdits[key] === undefined) return false;
      return detailsRowMatchesSearch(label, value, draftEdits[key], key, query);
    });
  }, [osEntries, normalizedDetailsQuery, draftEdits]);

  const filteredImageGroups = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (!query && !hasEditsFilter) return imageGroups;
    return imageGroups
      .map((g) => ({
        ...g,
        entries: g.entries.filter((e) => {
          if (hasEditsFilter && draftEdits[e.identityToken] === undefined)
            return false;
          return detailsRowMatchesSearch(
            e.label,
            e.value,
            draftEdits[e.identityToken],
            e.friendlyName,
            query,
          );
        }),
      }))
      .filter((g) => g.entries.length > 0);
  }, [imageGroups, normalizedDetailsQuery, draftEdits]);

  const occurrenceEntries = useMemo(() => {
    if (
      metadata === "loading" ||
      occurrences === undefined ||
      occurrences === "loading"
    ) {
      return [];
    }
    return unprojectedResolvedMetadataOccurrences(occurrences, metadata);
  }, [metadata, occurrences]);

  const filteredOccurrenceEntries = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (hasEditsFilter) return [];
    if (!query) return occurrenceEntries;
    return occurrenceEntries.filter((entry) =>
      haystackContainsNormalized(entry.searchText, query),
    );
  }, [occurrenceEntries, normalizedDetailsQuery]);

  const showOsSection = !normalizedDetailsQuery || filteredOsEntries.length > 0;

  return (
    <div className="details-pane" data-testid="details-pane">
      <h2
        className="details-pane-title"
        style={{ display: "flex", alignItems: "center" }}
      >
        Properties
        {Object.keys(draftEdits).length > 0 && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span
              className="row-draft-badge"
              style={{ cursor: "pointer", marginLeft: 0 }}
              onClick={() => setDetailsSearch("has:edits")}
              title="Show only edited fields"
            >
              {Object.keys(draftEdits).length} edit
              {Object.keys(draftEdits).length === 1 ? "" : "s"}
            </span>
            {onApplyEdits && (
              <button
                className="button button--primary"
                style={{
                  padding: "2px 6px",
                  fontSize: "11px",
                  minHeight: "auto",
                  borderRadius: "8px",
                }}
                onClick={async () => {
                  const editCount = Object.keys(draftEdits).length;
                  const confirmed = await confirmApplyEdits({
                    editCount,
                    target: "this photo",
                    photoCount: 1,
                  });
                  if (confirmed) onApplyEdits();
                }}
                data-testid="details-pane-apply-btn"
                title="Apply draft edits to the original image file"
              >
                Apply
              </button>
            )}
            <button
              className="button button--secondary"
              style={{
                padding: "2px 6px",
                fontSize: "11px",
                minHeight: "auto",
                borderRadius: "8px",
              }}
              onClick={async () => {
                if (!onDiscardAllEdits) return;
                const editCount = Object.keys(draftEdits).length;
                const confirmed = await confirmDiscardEdits({
                  editCount,
                  scope: "this photo",
                });
                if (confirmed) onDiscardAllEdits();
              }}
              title="Discard all edits for this photo"
            >
              Discard all edits
            </button>
          </div>
        )}
      </h2>

      <div className="details-pane-toolbar">
        <label className="details-search-label" htmlFor="details-search-input">
          Search
        </label>
        <input
          id="details-search-input"
          type="search"
          className="details-search-input"
          data-testid="details-search-input"
          placeholder="Filter keys and values…"
          value={detailsSearch}
          onChange={(e) => setDetailsSearch(e.target.value)}
          aria-label="Search properties"
        />
      </div>

      <div className="details-pane-body">
        {/* OS Metadata */}
        {showOsSection && (
          <section className="details-section" data-testid="details-section-os">
            <h3 className="details-section-header">OS Metadata</h3>
            <table className="details-table">
              <tbody>
                {filteredOsEntries.map(([label, value, propKey]) => (
                  <tr
                    key={label}
                    className="details-row"
                    data-testid="details-row"
                  >
                    <td
                      className="details-key"
                      style={
                        draftEdits[propKey] !== undefined
                          ? { color: "var(--accent-draft)" }
                          : undefined
                      }
                    >
                      <HighlightedText
                        text={label}
                        searchQuery={detailsSearch}
                      />
                    </td>
                    <DetailsValueCell
                      originalValue={value}
                      draftValue={draftEdits[propKey]}
                      searchQuery={detailsSearch}
                      readOnly
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Image Metadata */}
        {metadata === "loading" ? (
          <section
            className="details-section"
            data-testid="details-section-loading"
          >
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-loading">Loading metadata…</div>
          </section>
        ) : (
          <>
            {filteredImageGroups.length === 0 &&
            filteredOccurrenceEntries.length === 0 ? (
              <section
                className="details-section"
                data-testid="details-section-empty"
              >
                <h3 className="details-section-header">Image Metadata</h3>
                <div className="details-empty">No image metadata available</div>
              </section>
            ) : (
              filteredImageGroups.map((group) => (
                <section
                  className="details-section"
                  key={group.prefix}
                  data-testid={`details-section-${group.prefix}`}
                >
                  <h3
                    className="details-section-header"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu(null);
                      setGroupContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        group: group.prefix,
                      });
                    }}
                  >
                    {group.prefix}
                  </h3>
                  {group.prefix === "GPS" &&
                  resolvedGps.lat !== null &&
                  resolvedGps.lon !== null ? (
                    <GpsMapOverview
                      lat={resolvedGps.lat}
                      lon={resolvedGps.lon}
                    />
                  ) : null}
                  <table className="details-table">
                    <tbody>
                      {group.entries.map((entry) => (
                        <DetailsImageRow
                          key={entry.identityToken}
                          entry={entry}
                          rawValue={
                            typeof metadata === "object"
                              ? metadataGet(metadata, entry.id)
                              : undefined
                          }
                          draftValue={draftEdits[entry.identityToken]}
                          typedDraft={
                            typedDraftEdits?.[entry.identityToken]?.edit
                          }
                          searchQuery={detailsSearch}
                          onContextMenu={(e, originalValue) =>
                            handleContextMenu(
                              e,
                              entry.id,
                              originalValue,
                              draftEdits[entry.identityToken],
                            )
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            )}
            {filteredOccurrenceEntries.length > 0 && (
              <section
                className="details-section"
                data-testid="details-section-additional-occurrences"
              >
                <h3 className="details-section-header">
                  Additional Metadata Occurrences
                </h3>
                <p className="details-section-subtitle">
                  Concrete metadata fields that cannot be represented uniquely
                  by the schema-keyed compatibility view.
                </p>
                <table className="details-table">
                  <tbody>
                    {filteredOccurrenceEntries.map((entry) => (
                      <DetailsOccurrenceRow
                        key={entry.identityToken}
                        entry={entry}
                        searchQuery={detailsSearch}
                      />
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}
      </div>

      {metadata !== "loading" && (
        <div className="details-pane-footer" data-testid="details-pane-footer">
          <button
            className="button button--secondary"
            onClick={() => setShowNewPropertyDialog(true)}
          >
            + Add Property…
          </button>
          {onShowInFileExplorer && (
            <button
              className="button button--secondary"
              data-testid="details-pane-show-in-explorer-btn"
              title="Reveal this image in the host file manager"
              onClick={() => onShowInFileExplorer()}
            >
              Show in File Explorer
            </button>
          )}
          {onGenerateAiDescription && (
            <button
              className="button button--secondary"
              data-testid="details-pane-generate-ai-btn"
              title="Generate an AI description for this image via OpenAI"
              onClick={() => onGenerateAiDescription()}
            >
              Generate AI Description…
            </button>
          )}
          {onGeocode && (
            <button
              className="button button--secondary"
              data-testid="details-pane-geocode-btn"
              title="Reverse-geocode this image's GPS via OpenStreetMap Nominatim"
              onClick={() => onGeocode()}
            >
              Reverse Geocode…
            </button>
          )}
          {onNormalise && (
            <button
              className="button button--secondary"
              data-testid="details-pane-normalise-btn"
              title="Normalise metadata: sync canonical fields across XMP / IPTC / EXIF"
              onClick={() => onNormalise()}
            >
              Normalise Metadata…
            </button>
          )}
        </div>
      )}

      {contextMenu && (
        <DetailsRowContextMenu
          contextMenu={contextMenu}
          onEdit={() => {
            setEditDialog({
              id: contextMenu.id,
              mode: "single",
            });
            setContextMenu(null);
          }}
          onEditGps={() => {
            setEditDialog({
              id: contextMenu.id,
              mode: "gps",
            });
            setContextMenu(null);
          }}
          onDiscard={() => {
            onDiscardDraft?.(contextMenu.id);
            setContextMenu(null);
          }}
          onRemove={() => {
            const existsInOriginal =
              metadata !== "loading" &&
              metadataGet(metadata, contextMenu.id) !== undefined;
            if (existsInOriginal) {
              onSetMetadataDraft?.(contextMenu.id, {
                value: null,
                intent: "Delete",
              });
            } else {
              onDiscardDraft?.(contextMenu.id);
            }
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {groupContextMenu && fullGroupForMenu && (
        <DetailsGroupContextMenu
          contextMenu={{
            x: groupContextMenu.x,
            y: groupContextMenu.y,
            group: groupContextMenu.group,
            entries: fullGroupForMenu.entries,
          }}
          originalMetadata={metadata !== "loading" ? metadata : undefined}
          draftEdits={draftEdits}
          onSetMetadataDraftBatch={onSetMetadataDraftBatch}
          onDiscardDraftBatch={onDiscardDraftBatch}
          onClose={() => setGroupContextMenu(null)}
        />
      )}

      {editDialog && (
        <TypedValueEditor
          propertyId={editDialog.id}
          editorMode={editDialog.mode}
          initialMetadataValue={
            effectiveMetadata
              ? metadataGet(effectiveMetadata, editDialog.id)
              : undefined
          }
          metadataForFile={effectiveMetadata}
          onSaveMetadataBatch={(edits) => {
            onSetMetadataDraftBatch(edits);
            setEditDialog(null);
          }}
          onSaveMetadata={(edit) => {
            onSetMetadataDraft?.(editDialog.id, edit);
            setEditDialog(null);
          }}
          onCancel={() => setEditDialog(null)}
        />
      )}

      {showNewPropertyDialog && (
        <NewPropertyDialog
          onSave={(key) => {
            setShowNewPropertyDialog(false);
            setNewPropertyKey(key);
          }}
          onCancel={() => setShowNewPropertyDialog(false)}
          existingIds={existingMetadataKeys}
          filename={photo.filename}
        />
      )}

      {newPropertyKey !== null && (
        <TypedValueEditor
          propertyId={newPropertyKey}
          editorMode="single"
          initialMetadataValue={undefined}
          metadataForFile={effectiveMetadata}
          onSaveMetadataBatch={(edits) => {
            onSetMetadataDraftBatch(edits);
            setNewPropertyKey(null);
          }}
          onSaveMetadata={(edit) => {
            onSetMetadataDraft?.(newPropertyKey, edit);
            setNewPropertyKey(null);
          }}
          onCancel={() => setNewPropertyKey(null)}
        />
      )}
    </div>
  );
}
