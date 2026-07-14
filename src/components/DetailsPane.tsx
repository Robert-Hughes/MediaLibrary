import { useEffect, useMemo, useState } from "react";
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  PhotoInfo,
  ImageMetadataState,
  ImageMetadataOccurrencesState,
  MetadataDraftCollection,
  MetadataValue,
  MetadataDraftTarget,
  TargetDraftPersistenceStateV5,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { TypedValueEditor } from "./editors/TypedValueEditor";
import { useTagInfo, useTagInfos } from "../hooks/useTagInfo";
import { DatatypeBadge } from "./DatatypeBadge";
import { gpsMemberGroup } from "../metadata/tag_overrides";
import {
  schemaDatatype,
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
  overlayUniqueOccurrenceValues,
  supplementalResolvedMetadataOccurrences,
} from "../utils/detailsPaneHelpers";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";
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
import type {
  SchemaOccurrenceResolution,
  SchemaOccurrenceResolutionIndex,
} from "../utils/metadataOccurrences";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolutionForSchema,
} from "../utils/metadataOccurrences";
import {
  resolveTargetDraftByExactSchema,
  targetDraftSchemas,
} from "../targetDraftView";

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
  /** Narrow, exact-target view used only by the migrated Add Property slice. */
  targetDraftEdits?: TargetDraftCollection;
  /** Folder-scoped safety state for the strict schema-v5 persistence file. */
  targetDraftPersistence?: TargetDraftPersistenceStateV5;
  /** Semantic setter used by every editor via the local adapter. */
  onSetMetadataDraft?: (
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ) => void;
  /** Batch setter for paired-tag editors (GPS). */
  onSetMetadataDraftBatch: (
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => void;
  onSetNewPropertyDraft?: (
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ) => void;
  onSetTargetPropertyDraft?: (
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
  ) => void;
  onDiscardTargetPropertyDraft?: (target: MetadataDraftTarget) => void;
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
  occurrenceResolution,
  searchQuery,
  onContextMenu,
}: {
  entry: MetadataEntry;
  rawValue: ImageMetadataEntry | undefined;
  draftValue: string | null | undefined;
  typedDraft: MetadataDraftEdit | undefined;
  occurrenceResolution: SchemaOccurrenceResolution;
  searchQuery: string;
  onContextMenu: (e: React.MouseEvent, originalValue: string) => void;
}) {
  const lookedUpTag = useTagInfo(
    occurrenceResolution.kind === "unique" &&
      occurrenceResolution.occurrence.tag_info !== null
      ? null
      : entry.id,
  );
  const fallbackTagInfo = lookedUpTag !== "loading" ? lookedUpTag : null;
  let tagInfo = fallbackTagInfo;
  let originalSemanticValue: MetadataValue | ImageMetadataEntry | undefined =
    rawValue;
  let readOnly =
    lookedUpTag != null && lookedUpTag !== "loading" && !lookedUpTag.writable;

  switch (occurrenceResolution.kind) {
    case "unique":
      originalSemanticValue = occurrenceResolution.occurrence.value;
      tagInfo = occurrenceResolution.occurrence.tag_info ?? fallbackTagInfo;
      readOnly = tagInfo != null && !tagInfo.writable;
      break;
    case "multiple":
      // This is only a compatibility aggregate. Never replace it with one
      // arbitrarily selected concrete occurrence.
      originalSemanticValue = rawValue;
      readOnly = true;
      break;
    case "missing":
      // Preserve the compatibility path for unresolved and legacy callers.
      break;
  }

  const originalValue = metadataValueToDisplayStringForTag(
    entry.id,
    originalSemanticValue,
    tagInfo,
  );
  const schemaInfo = tagInfo ? schemaDatatype(tagInfo.kind) : null;

  const valueInfo = metadataValueDatatype(originalSemanticValue);
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
  const ambiguous = occurrenceResolution.kind === "multiple";
  const ambiguityTitle = ambiguous
    ? [
        "Several runtime metadata occurrences share this schema identity.",
        "The schema-keyed compatibility row cannot identify one occurrence.",
        "See Additional Metadata Occurrences for the concrete values.",
        ...(draftValue !== undefined
          ? [
              "This draft is keyed by schema identity and is not assigned to any one runtime occurrence.",
            ]
          : []),
      ].join("\n")
    : undefined;

  return (
    <tr
      key={entry.identityToken}
      className={readOnly ? "details-row details-row--readonly" : "details-row"}
      data-testid="details-row"
      data-row-key={entry.identityToken}
      data-readonly={readOnly ? "true" : undefined}
      data-occurrence-resolution={ambiguous ? "multiple" : undefined}
      title={ambiguityTitle}
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
        {ambiguous ? (
          <span
            className="details-occurrence-resolution"
            title={ambiguityTitle}
          >
            {occurrenceResolution.occurrences.length} occurrences
          </span>
        ) : null}
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
  occurrenceResolution,
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
  occurrenceResolution: SchemaOccurrenceResolution;
  onEdit: () => void;
  onEditGps?: () => void;
  onDiscard: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const tag = useTagInfo(
    occurrenceResolution.kind === "missing" ? contextMenu.id : null,
  );
  const readOnly = (() => {
    switch (occurrenceResolution.kind) {
      case "multiple":
        return true;
      case "unique":
        return !(occurrenceResolution.occurrence.tag_info?.writable ?? false);
      case "missing":
        return tag !== null && tag !== "loading" && !tag.writable;
    }
  })();
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
  occurrenceResolutionIndex,
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
  occurrenceResolutionIndex: SchemaOccurrenceResolutionIndex;
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
  const schemaLookupIds = useMemo(
    () =>
      ids.filter(
        (id) =>
          resolutionForSchema(occurrenceResolutionIndex, id).kind === "missing",
      ),
    [ids, occurrenceResolutionIndex],
  );
  const tagInfos = useTagInfos(schemaLookupIds);

  const isLoading = schemaLookupIds.some(
    (id) => tagInfos[schemaDefinitionIdToken(id)] === "loading",
  );

  const removableKeys = useMemo(() => {
    if (isLoading) return [];
    return ids.filter((id) => {
      const resolution = resolutionForSchema(occurrenceResolutionIndex, id);
      switch (resolution.kind) {
        case "multiple":
          return false;
        case "unique":
          return resolution.occurrence.tag_info?.writable ?? false;
        case "missing": {
          const tag = tagInfos[schemaDefinitionIdToken(id)];
          return tag === null || (tag !== "loading" && tag.writable);
        }
      }
    });
  }, [ids, tagInfos, isLoading, occurrenceResolutionIndex]);

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
  targetDraftEdits,
  targetDraftPersistence = { status: "ready" },
  onSetMetadataDraft,
  onSetMetadataDraftBatch,
  onSetNewPropertyDraft,
  onSetTargetPropertyDraft,
  onDiscardTargetPropertyDraft,
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

  const targetDraftsWritable = targetDraftPersistence.status === "ready";
  const addPropertyUnavailableTitle = targetDraftsWritable
    ? "Add a metadata property"
    : "Add Property is unavailable because target-aware drafts could not be loaded safely. Fix the schema-v5 draft persistence file, then reopen the folder.";

  useEffect(() => {
    if (targetDraftsWritable) return;
    setShowNewPropertyDialog(false);
    setNewPropertyKey(null);
  }, [targetDraftsWritable]);

  const occurrenceResolutionIndex = useMemo(
    () =>
      occurrences === undefined || occurrences === "loading"
        ? new Map<string, SchemaOccurrenceResolution>()
        : buildSchemaOccurrenceResolutionIndex(occurrences),
    [occurrences],
  );
  const targetSchemaResolutions = useMemo(() => {
    const resolutions = new Map<
      string,
      ReturnType<typeof resolveTargetDraftByExactSchema>
    >();
    for (const id of targetDraftSchemas(targetDraftEdits)) {
      resolutions.set(
        schemaDefinitionIdToken(id),
        resolveTargetDraftByExactSchema(targetDraftEdits, id),
      );
    }
    return resolutions;
  }, [targetDraftEdits]);
  const uniqueTargetDrafts = useMemo(
    () =>
      Array.from(targetSchemaResolutions.entries()).flatMap(
        ([token, resolution]) =>
          resolution.kind === "unique"
            ? [[token, resolution.entry] as const]
            : [],
      ),
    [targetSchemaResolutions],
  );
  const ambiguousTargetDrafts = useMemo(
    () =>
      Array.from(targetSchemaResolutions.entries()).filter(
        (
          entry,
        ): entry is [
          string,
          Extract<
            ReturnType<typeof resolveTargetDraftByExactSchema>,
            { kind: "ambiguous" }
          >,
        ] => entry[1].kind === "ambiguous",
      ),
    [targetSchemaResolutions],
  );
  const authoritativeBaseMetadata = useMemo(
    () =>
      metadata === "loading"
        ? undefined
        : overlayUniqueOccurrenceValues(metadata, occurrenceResolutionIndex),
    [metadata, occurrenceResolutionIndex],
  );
  const effectiveMetadata = useMemo(() => {
    if (authoritativeBaseMetadata === undefined) return undefined;
    const effective = buildEffectiveMetadata(
      authoritativeBaseMetadata,
      typedDraftEdits,
    );
    for (const [token, entry] of uniqueTargetDrafts) {
      if (entry.edit.intent === "Set" && entry.edit.value) {
        effective[token] = {
          ...entry.edit.value,
          id: entry.target.schema_id,
        } as ImageMetadataEntry;
      } else if (entry.edit.intent === "Delete") {
        delete effective[token];
      }
    }
    return effective;
  }, [authoritativeBaseMetadata, typedDraftEdits, uniqueTargetDrafts]);
  const resolvedGps = useMemo(() => {
    if (metadata === "loading") return { lat: null, lon: null };
    return resolveGps(typedDraftEdits, metadata);
  }, [typedDraftEdits, metadata]);

  const legacyDraftEdits = useMemo(
    () =>
      displayDraftEdits
        ? { ...displayDraftEdits }
        : Object.fromEntries(
            Object.entries(typedDraftEdits ?? {})
              .map(
                ([key, entry]) =>
                  [key, displayStringOfDraft(entry.edit)] as const,
              )
              .filter(
                (entry): entry is readonly [string, string | null] =>
                  entry[1] !== undefined,
              ),
          ),
    [displayDraftEdits, typedDraftEdits],
  );
  const draftEdits = useMemo(() => {
    const combined = { ...legacyDraftEdits };
    for (const [token, entry] of uniqueTargetDrafts) {
      const display = displayStringOfDraft(entry.edit);
      if (display !== undefined) combined[token] = display;
    }
    return combined;
  }, [legacyDraftEdits, uniqueTargetDrafts]);

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
        const absentFromLegacy =
          metadata !== "loading" &&
          metadataGet(metadata, entry.id) === undefined;
        const ambiguousDelete =
          entry.edit.intent === "Delete" &&
          absentFromLegacy &&
          resolutionForSchema(occurrenceResolutionIndex, entry.id).kind ===
            "multiple";
        if (entry.edit.intent !== "Delete" || ambiguousDelete) {
          ids.push(entry.id);
        }
      }
    }
    for (const [, entry] of uniqueTargetDrafts) {
      if (entry.edit.intent !== "Delete") ids.push(entry.target.schema_id);
    }
    return ids;
  }, [
    metadata,
    typedDraftEdits,
    occurrenceResolutionIndex,
    uniqueTargetDrafts,
  ]);
  const schemaLookupIds = useMemo(
    () =>
      displayIds.filter(
        (id) =>
          resolutionForSchema(occurrenceResolutionIndex, id).kind !== "unique",
      ),
    [displayIds, occurrenceResolutionIndex],
  );
  const lookedUpDisplayTagInfos = useTagInfos(schemaLookupIds);
  const displayTagInfos = useMemo(() => {
    const result = { ...lookedUpDisplayTagInfos };
    for (const id of displayIds) {
      const resolution = resolutionForSchema(occurrenceResolutionIndex, id);
      if (
        resolution.kind === "unique" &&
        resolution.occurrence.tag_info !== null
      ) {
        result[schemaDefinitionIdToken(id)] = resolution.occurrence.tag_info;
      }
    }
    return result;
  }, [displayIds, lookedUpDisplayTagInfos, occurrenceResolutionIndex]);
  const imageGroups = useMemo(() => {
    if (metadata === "loading") return [];

    const combinedMetadata: Record<string, ImageMetadataEntry> = {
      ...metadata,
    };
    if (typedDraftEdits) {
      for (const entry of Object.values(typedDraftEdits)) {
        const absentFromLegacy = metadataGet(metadata, entry.id) === undefined;
        const ambiguousDelete =
          entry.edit.intent === "Delete" &&
          absentFromLegacy &&
          resolutionForSchema(occurrenceResolutionIndex, entry.id).kind ===
            "multiple";
        if (
          absentFromLegacy &&
          (entry.edit.intent !== "Delete" || ambiguousDelete)
        ) {
          combinedMetadata[schemaDefinitionIdToken(entry.id)] = {
            kind: "Null",
            id: entry.id,
          };
        }
      }
    }
    for (const [token, entry] of uniqueTargetDrafts) {
      if (
        metadataGet(metadata, entry.target.schema_id) === undefined &&
        entry.edit.intent !== "Delete"
      ) {
        combinedMetadata[token] = {
          kind: "Null",
          id: entry.target.schema_id,
        };
      }
    }
    return groupImageMetadata(combinedMetadata, displayTagInfos);
  }, [
    metadata,
    typedDraftEdits,
    displayTagInfos,
    occurrenceResolutionIndex,
    uniqueTargetDrafts,
  ]);

  const editDialogResolution = editDialog
    ? resolutionForSchema(occurrenceResolutionIndex, editDialog.id)
    : null;
  const editDialogInitialValue =
    editDialog && effectiveMetadata
      ? metadataGet(effectiveMetadata, editDialog.id)
      : undefined;
  const editDialogRenderKey = editDialog
    ? `${schemaDefinitionIdToken(editDialog.id)}:${JSON.stringify({
        occurrence:
          editDialogResolution?.kind === "unique"
            ? editDialogResolution.occurrence.id
            : null,
        value: editDialogInitialValue,
      })}`
    : undefined;

  useEffect(() => {
    if (editDialog && editDialogResolution?.kind === "multiple") {
      setEditDialog(null);
    }
  }, [editDialog, editDialogResolution]);

  const fullGroupForMenu = useMemo(() => {
    if (!groupContextMenu) return null;
    return imageGroups.find((g) => g.prefix === groupContextMenu.group) ?? null;
  }, [groupContextMenu, imageGroups]);

  const existingMetadataKeys = useMemo(() => {
    const ids = [...displayIds];
    for (const id of targetDraftSchemas(targetDraftEdits)) {
      if (!ids.some((candidate) => schemaDefinitionIdEquals(candidate, id))) {
        ids.push(id);
      }
    }
    return ids;
  }, [displayIds, targetDraftEdits]);

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
          const resolution = resolutionForSchema(
            occurrenceResolutionIndex,
            e.id,
          );
          const ambiguitySearchText =
            resolution.kind === "multiple"
              ? `multiple occurrences\n${resolution.occurrences.length} occurrences`
              : "";
          const searchableOriginalValue =
            resolution.kind === "unique" &&
            resolution.occurrence.tag_info !== null
              ? metadataValueToDisplayStringForTag(
                  e.id,
                  resolution.occurrence.value,
                  resolution.occurrence.tag_info,
                )
              : e.value;
          return detailsRowMatchesSearch(
            e.label,
            searchableOriginalValue,
            draftEdits[e.identityToken],
            `${e.friendlyName}\n${ambiguitySearchText}`,
            query,
          );
        }),
      }))
      .filter((g) => g.entries.length > 0);
  }, [
    imageGroups,
    normalizedDetailsQuery,
    draftEdits,
    occurrenceResolutionIndex,
  ]);

  const occurrenceEntries = useMemo(() => {
    if (
      metadata === "loading" ||
      occurrences === undefined ||
      occurrences === "loading"
    ) {
      return [];
    }
    return supplementalResolvedMetadataOccurrences(
      occurrences,
      metadata,
      occurrenceResolutionIndex,
    );
  }, [metadata, occurrences, occurrenceResolutionIndex]);

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
                      {group.entries.map((entry) => {
                        const occurrenceResolution = resolutionForSchema(
                          occurrenceResolutionIndex,
                          entry.id,
                        );
                        const targetResolution = targetSchemaResolutions.get(
                          entry.identityToken,
                        );
                        return (
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
                              targetResolution?.kind === "unique"
                                ? targetResolution.entry.edit
                                : typedDraftEdits?.[entry.identityToken]?.edit
                            }
                            occurrenceResolution={occurrenceResolution}
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
                        );
                      })}
                    </tbody>
                  </table>
                </section>
              ))
            )}
            {ambiguousTargetDrafts.length > 0 && (
              <section
                className="details-section"
                data-testid="details-target-drafts-ambiguous"
              >
                <h3 className="details-section-header">
                  Ambiguous staged properties
                </h3>
                <p className="details-section-subtitle">
                  Multiple target-aware occurrences share the same exact schema.
                  Apply or discard them individually before editing this
                  property; no occurrence was selected automatically.
                </p>
              </section>
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
            data-testid="details-pane-add-property-btn"
            disabled={!targetDraftsWritable}
            title={addPropertyUnavailableTitle}
            onClick={() => {
              if (targetDraftsWritable) setShowNewPropertyDialog(true);
            }}
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
          occurrenceResolution={resolutionForSchema(
            occurrenceResolutionIndex,
            contextMenu.id,
          )}
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
            const targetResolution = resolveTargetDraftByExactSchema(
              targetDraftEdits,
              contextMenu.id,
            );
            if (targetResolution.kind === "unique") {
              onDiscardTargetPropertyDraft?.(targetResolution.entry.target);
            } else if (targetResolution.kind === "missing") {
              onDiscardDraft?.(contextMenu.id);
            }
            setContextMenu(null);
          }}
          onRemove={() => {
            const existsInOriginal =
              metadata !== "loading" &&
              metadataGet(metadata, contextMenu.id) !== undefined;
            const targetResolution = resolveTargetDraftByExactSchema(
              targetDraftEdits,
              contextMenu.id,
            );
            if (targetResolution.kind === "unique") {
              onDiscardTargetPropertyDraft?.(targetResolution.entry.target);
            } else if (targetResolution.kind === "ambiguous") {
              // The explicit ambiguity panel is the only safe presentation.
            } else if (existsInOriginal) {
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
          draftEdits={legacyDraftEdits}
          occurrenceResolutionIndex={occurrenceResolutionIndex}
          onSetMetadataDraftBatch={onSetMetadataDraftBatch}
          onDiscardDraftBatch={onDiscardDraftBatch}
          onClose={() => setGroupContextMenu(null)}
        />
      )}

      {editDialog && editDialogResolution?.kind !== "multiple" && (
        <TypedValueEditor
          key={editDialogRenderKey}
          propertyId={editDialog.id}
          editorMode={editDialog.mode}
          initialMetadataValue={editDialogInitialValue}
          metadataForFile={effectiveMetadata}
          onSaveMetadataBatch={(edits) => {
            onSetMetadataDraftBatch(edits);
            setEditDialog(null);
          }}
          onSaveMetadata={(edit) => {
            const targetResolution = resolveTargetDraftByExactSchema(
              targetDraftEdits,
              editDialog.id,
            );
            if (targetResolution.kind === "unique") {
              onSetTargetPropertyDraft?.(targetResolution.entry.target, edit);
            } else if (targetResolution.kind === "missing") {
              onSetMetadataDraft?.(editDialog.id, edit);
            }
            setEditDialog(null);
          }}
          onCancel={() => setEditDialog(null)}
        />
      )}

      {targetDraftsWritable && showNewPropertyDialog && (
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

      {newPropertyKey !== null && targetDraftsWritable && (
        <TypedValueEditor
          propertyId={newPropertyKey}
          editorMode="single"
          initialMetadataValue={undefined}
          metadataForFile={effectiveMetadata}
          onSaveMetadataBatch={(edits) => {
            for (const { id, edit } of edits) {
              onSetNewPropertyDraft?.(id, edit);
            }
            setNewPropertyKey(null);
          }}
          onSaveMetadata={(edit) => {
            onSetNewPropertyDraft?.(newPropertyKey, edit);
            setNewPropertyKey(null);
          }}
          onCancel={() => setNewPropertyKey(null)}
        />
      )}
    </div>
  );
}
