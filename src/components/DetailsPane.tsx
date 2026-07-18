import { useEffect, useMemo, useState } from "react";
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  PhotoInfo,
  ImageMetadataOccurrencesState,
  MetadataValue,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataTargetDraftEntry,
  TargetDraftPersistenceState,
} from "../types";
import { metadataValueEqual } from "../types";
import {
  metadataTargetDraftEntryEqualsExact,
  type TargetDraftCollection,
} from "../targetDraftEdits";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { TypedValueEditor } from "./editors/TypedValueEditor";
import { useTagInfo, useTagInfos } from "../hooks/useTagInfo";
import { DatatypeBadge } from "./DatatypeBadge";
import { gpsMemberGroup, type GpsTagGroup } from "../metadata/tag_overrides";
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
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { buildEffectiveMetadataForFile } from "../utils/effectiveMetadata";
import { metadataGet } from "../utils/metadataCollection";
import { schemaMetadataCollectionFromOccurrences } from "../utils/schemaMetadataProjection";
import type { SchemaOccurrenceResolution } from "../utils/metadataOccurrences";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolveExactMetadataOccurrence,
  resolutionForSchema,
} from "../utils/metadataOccurrences";
import {
  resolveExistingRowDraft,
  resolveSupplementalOccurrenceDraft,
  resolveTargetDraftByExactSchema,
  targetDraftSchemas,
} from "../targetDraftView";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "../utils/metadataDraftTarget";
import { metadataOccurrenceIdToken } from "../utils/metadataOccurrenceId";
import { tagInfoSupportsMetadataWrite } from "../utils/metadataWriteSupport";
import {
  metadataWriteSelector,
  validateFamily1Group,
} from "../utils/metadataWriteTarget";
import {
  planGpsTargetDraftBatch,
  validateGpsTargetDraftEntries,
} from "../gpsTargetDrafts";
import { previewMetadataRemovalTargets } from "../metadataRemovalTargets";

type ExistingOccurrenceTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;
type NewPropertyTarget = Extract<MetadataDraftTarget, { kind: "NewProperty" }>;

type EditDialogState =
  | {
      kind: "existing-occurrence";
      schemaId: SchemaDefinitionId;
      occurrenceId: MetadataOccurrenceId;
      openedTarget: ExistingOccurrenceTarget;
    }
  | {
      kind: "gps-composite";
      group: GpsTagGroup;
      openedTargets: Record<string, MetadataDraftTarget>;
      openedDraftTargets: MetadataDraftTarget[];
    }
  | {
      kind: "new-property";
      schemaId: SchemaDefinitionId;
      openedTarget: NewPropertyTarget;
      openedEdit: MetadataDraftEdit;
    };

type PresentedTargetDraft =
  | {
      destination: "ordinary-row";
      entry: MetadataTargetDraftEntry;
      occurrence?: MetadataOccurrence;
    }
  | {
      destination: "supplemental-row";
      entry: MetadataTargetDraftEntry & { target: ExistingOccurrenceTarget };
      occurrence: MetadataOccurrence;
    };

interface Props {
  photo: PhotoInfo;
  /** Authoritative occurrences are the sole metadata state. */
  occurrences: ImageMetadataOccurrencesState;
  /** Exact-target drafts for Add Property and unique existing rows. */
  targetDraftEdits?: TargetDraftCollection;
  /** Folder-scoped safety state for the strict target-aware persistence file. */
  targetDraftPersistence?: TargetDraftPersistenceState;
  onSetExistingOccurrenceDraft?: (
    target: ExistingOccurrenceTarget,
    edit: MetadataDraftEdit,
  ) => void;
  onRemoveMetadataFields?: (ids: SchemaDefinitionId[]) => boolean;
  onApplyGpsTargetDraftBatch?: (entries: MetadataTargetDraftEntry[]) => boolean;
  onSetNewPropertyDraft?: (
    target: NewPropertyTarget,
    edit: MetadataDraftEdit,
  ) => Promise<boolean>;
  onReplaceNewPropertyDraftTarget?: (
    originalTarget: NewPropertyTarget,
    replacementTarget: NewPropertyTarget,
    originalEdit: MetadataDraftEdit,
  ) => Promise<boolean>;
  onDiscardTargetPropertyDraft?: (target: MetadataDraftTarget) => void;
  onDiscardTargetDraftBatch?: (targets: MetadataDraftTarget[]) => boolean;
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

function gpsGroupIds(group: GpsTagGroup): SchemaDefinitionId[] {
  return [
    group.latitudeId,
    group.latitudeRefId,
    group.longitudeId,
    group.longitudeRefId,
    group.altitudeId,
    group.altitudeRefId,
  ];
}

function effectiveExistingDraftValue(
  original: MetadataValue,
  edit: MetadataDraftEdit,
): MetadataValue {
  if (edit.intent === "Set" && edit.value !== null) return edit.value;
  if (edit.intent === "Delete" || edit.value === null) return original;
  if (original.kind !== "List") return edit.value;

  const stagedItems =
    edit.value.kind === "List" ? edit.value.value.items : [edit.value];
  if (edit.intent === "ListRemove") {
    return {
      kind: "List",
      value: {
        ...original.value,
        items: original.value.items.filter(
          (item) =>
            !stagedItems.some((staged) => metadataValueEqual(item, staged)),
        ),
      },
    };
  }
  if (edit.intent === "ListAdd") {
    return {
      kind: "List",
      value: {
        ...original.value,
        items: [
          ...original.value.items,
          ...stagedItems.filter(
            (item) =>
              !original.value.items.some((existing) =>
                metadataValueEqual(existing, item),
              ),
          ),
        ],
      },
    };
  }
  return original;
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
  unavailableReason,
}: {
  entry: MetadataEntry;
  rawValue: ImageMetadataEntry | undefined;
  draftValue: string | null | undefined;
  typedDraft: MetadataDraftEdit | undefined;
  occurrenceResolution: SchemaOccurrenceResolution;
  searchQuery: string;
  onContextMenu: (e: React.MouseEvent, originalValue: string) => void;
  unavailableReason?: string;
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
      // This is only a schema projection. Never replace it with one
      // arbitrarily selected concrete occurrence.
      originalSemanticValue = rawValue;
      readOnly = true;
      break;
    case "missing":
      // Preserve the compatibility path for unresolved read-only or direct callers.
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
        "The ordinary schema row cannot identify one occurrence.",
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
      className={
        readOnly || unavailableReason
          ? "details-row details-row--readonly"
          : "details-row"
      }
      data-testid="details-row"
      data-row-key={entry.identityToken}
      data-readonly={readOnly || unavailableReason ? "true" : undefined}
      data-occurrence-resolution={ambiguous ? "multiple" : undefined}
      title={unavailableReason ?? ambiguityTitle}
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
        readOnly={readOnly || unavailableReason !== undefined}
      />
    </tr>
  );
}

function DetailsOccurrenceRow({
  entry,
  searchQuery,
  targetDraft,
  unavailableReason,
  onContextMenu,
}: {
  entry: MetadataOccurrenceDisplayEntry;
  searchQuery: string;
  targetDraft?: MetadataTargetDraftEntry & { target: ExistingOccurrenceTarget };
  unavailableReason?: string;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const schemaInfo = schemaDatatype(entry.occurrence.tag_info?.kind);
  const valueInfo = metadataValueDatatype(entry.occurrence.value);
  const showValueBadge =
    valueInfo != null &&
    (schemaInfo == null || !datatypesMatch(valueInfo.code, schemaInfo.code));
  const effectiveDraftValue = targetDraft
    ? effectiveExistingDraftValue(entry.occurrence.value, targetDraft.edit)
    : undefined;
  const draftValue = targetDraft
    ? targetDraft.edit.intent === "Delete"
      ? null
      : entry.occurrence.tag_info
        ? metadataValueToDisplayStringForTag(
            entry.occurrence.schema_id,
            effectiveDraftValue,
            entry.occurrence.tag_info,
          )
        : displayStringOfDraft(targetDraft.edit)
    : undefined;
  const draftInfo =
    targetDraft && targetDraft.edit.intent !== "Delete"
      ? metadataValueDatatype(effectiveDraftValue)
      : null;
  const showDraftBadge =
    draftInfo != null &&
    ((valueInfo != null && draftInfo.code !== valueInfo.code) ||
      (schemaInfo != null &&
        !datatypesMatch(draftInfo.code, schemaInfo.code)) ||
      (schemaInfo == null && valueInfo == null));
  const readOnly = unavailableReason !== undefined;
  const title = [entry.originTitle, unavailableReason]
    .filter((part): part is string => part !== undefined)
    .join("\n");

  return (
    <tr
      className={readOnly ? "details-row details-row--readonly" : "details-row"}
      data-testid="details-occurrence-row"
      data-occurrence-token={entry.identityToken}
      data-readonly={readOnly ? "true" : undefined}
      data-has-exact-draft={targetDraft ? "true" : undefined}
      title={title}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!readOnly) onContextMenu?.(event);
      }}
    >
      <td
        className="details-key"
        style={targetDraft ? { color: "var(--accent-draft)" } : undefined}
      >
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
      <DetailsValueCell
        originalValue={entry.value}
        draftValue={draftValue}
        searchQuery={searchQuery}
        valueBadge={showValueBadge ? valueInfo : null}
        draftBadge={showDraftBadge ? draftInfo : null}
        readOnly={readOnly}
      />
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
  onEditDestination,
  onEditGps,
  onDiscard,
  onRemove,
  onClose,
  editingUnavailableReason,
  gpsEditingUnavailableReason,
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
  onEditDestination?: () => void;
  onEditGps?: () => void;
  onDiscard: () => void;
  onRemove: () => void;
  onClose: () => void;
  editingUnavailableReason?: string;
  gpsEditingUnavailableReason?: string;
}) {
  const tag = useTagInfo(
    occurrenceResolution.kind === "missing" ? contextMenu.id : null,
  );
  const schemaReadOnly = (() => {
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
  const readOnly = schemaReadOnly || editingUnavailableReason !== undefined;
  const options = [
    ...(readOnly
      ? []
      : [
          {
            label: "Edit…",
            onClick: onEdit,
            title: editingUnavailableReason,
          },
          ...(onEditDestination
            ? [{ label: "Edit destination…", onClick: onEditDestination }]
            : []),
        ]),
    ...(gpsGroup && onEditGps
      ? [
          {
            label: "Edit GPS…",
            onClick: onEditGps,
            disabled: gpsEditingUnavailableReason !== undefined,
            title: gpsEditingUnavailableReason,
          },
        ]
      : []),
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

function compositeGpsEditingAvailability({
  group,
  occurrences,
  targetDraftEdits,
  targetDraftPersistence,
  callbackAvailable,
}: {
  group: GpsTagGroup;
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDraftEdits: TargetDraftCollection | undefined;
  targetDraftPersistence: TargetDraftPersistenceState;
  callbackAvailable: boolean;
}): { blocked?: string } {
  if (targetDraftPersistence.status !== "ready")
    return {
      blocked:
        "Target-aware GPS editing is unavailable because target-aware draft persistence did not load safely. Nothing was saved.",
    };
  if (!callbackAvailable)
    return {
      blocked:
        "Target-aware GPS editing is unavailable in this view. Nothing was saved.",
    };
  try {
    planGpsTargetDraftBatch(
      gpsGroupIds(group).map((id) => ({
        id,
        edit: { intent: "Delete" as const, value: null },
      })),
      occurrences ?? "loading",
      targetDraftEdits,
    );
    return {};
  } catch (error) {
    return { blocked: error instanceof Error ? error.message : String(error) };
  }
}

function DetailsGroupContextMenu({
  contextMenu,
  occurrences,
  targetDraftEdits,
  targetDraftPersistence,
  onEditGps,
  onRemoveMetadataFields,
  onDiscardTargetDraftBatch,
  onBlocked,
  onClose,
}: {
  contextMenu: {
    x: number;
    y: number;
    group: string;
    entries: MetadataEntry[];
  };
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDraftEdits: TargetDraftCollection | undefined;
  targetDraftPersistence: TargetDraftPersistenceState;
  onEditGps?: (group: GpsTagGroup) => void;
  onRemoveMetadataFields?: (ids: SchemaDefinitionId[]) => boolean;
  onDiscardTargetDraftBatch?: (targets: MetadataDraftTarget[]) => boolean;
  onBlocked: (message: string) => void;
  onClose: () => void;
}) {
  const group = contextMenu.group;
  const gpsGroup = useMemo(() => {
    if (contextMenu.group !== "GPS") return null;

    for (const entry of contextMenu.entries) {
      const candidate = gpsMemberGroup(entry.id);
      if (candidate !== null) return candidate;
    }

    return null;
  }, [contextMenu.group, contextMenu.entries]);
  const ids = useMemo(
    () =>
      Array.from(
        new Map(
          contextMenu.entries.map((entry) => [
            schemaDefinitionIdToken(entry.id),
            entry.id,
          ]),
        ).values(),
      ),
    [contextMenu.entries],
  );
  const idTokens = useMemo(
    () => new Set(ids.map(schemaDefinitionIdToken)),
    [ids],
  );
  const removalIds = useMemo(() => {
    if (!Array.isArray(occurrences)) return ids;
    const index = buildSchemaOccurrenceResolutionIndex(occurrences);
    return ids.filter((id) => {
      const resolution = resolutionForSchema(index, id);
      return (
        resolution.kind !== "unique" ||
        (resolution.occurrence.tag_info !== null &&
          tagInfoSupportsMetadataWrite(resolution.occurrence.tag_info))
      );
    });
  }, [ids, occurrences]);
  const targetDraftTargets = useMemo(
    () =>
      Object.values(targetDraftEdits ?? {})
        .filter((entry) =>
          idTokens.has(schemaDefinitionIdToken(entry.target.schema_id)),
        )
        .map((entry) => structuredClone(entry.target)),
    [idTokens, targetDraftEdits],
  );

  const removalPreview = useMemo(() => {
    if (targetDraftPersistence.status !== "ready") {
      return {
        blocked:
          "Group removal is unavailable because target-aware draft persistence did not load safely.",
      };
    }
    if (!Array.isArray(occurrences)) {
      return {
        blocked:
          "Authoritative metadata occurrences are still loading. Retry after this photo has finished loading.",
      };
    }
    if (removalIds.length === 0) {
      return {
        preview: {
          existingFieldsToDelete: 0,
          stagedCreationsToCancel: 0,
          noOpFields: 0,
          affectedCount: 0,
        },
      };
    }
    try {
      return {
        preview: previewMetadataRemovalTargets({
          schemaIds: removalIds,
          occurrences,
          targetDrafts: targetDraftEdits,
        }),
      };
    } catch (error) {
      return {
        blocked: error instanceof Error ? error.message : String(error),
      };
    }
  }, [
    occurrences,
    removalIds,
    targetDraftEdits,
    targetDraftPersistence.status,
  ]);

  const gpsEditPreview = useMemo<null | { blocked?: string }>(() => {
    if (gpsGroup === null) return null;
    return compositeGpsEditingAvailability({
      group: gpsGroup,
      occurrences,
      targetDraftEdits,
      targetDraftPersistence,
      callbackAvailable: onEditGps !== undefined,
    });
  }, [
    gpsGroup,
    occurrences,
    onEditGps,
    targetDraftEdits,
    targetDraftPersistence,
  ]);
  const removeCount = removalPreview.preview?.affectedCount ?? 0;
  const draftCount = targetDraftTargets.length;
  const showEditGps = gpsEditPreview !== null;
  const showRemove =
    removalIds.length > 0 &&
    (removeCount > 0 || removalPreview.blocked !== undefined);

  useEffect(() => {
    if (!showEditGps && !showRemove && draftCount === 0) onClose();
  }, [draftCount, onClose, showEditGps, showRemove]);
  if (!showEditGps && !showRemove && draftCount === 0) return null;

  const handleRemove = async () => {
    if (removalPreview.blocked) {
      onBlocked(removalPreview.blocked);
      onClose();
      return;
    }
    const confirmed = await confirmRemoveMetadataGroupFields({
      group,
      existingFieldsToDelete:
        removalPreview.preview?.existingFieldsToDelete ?? 0,
      stagedCreationsToCancel:
        removalPreview.preview?.stagedCreationsToCancel ?? 0,
    });
    if (confirmed) {
      onRemoveMetadataFields?.(removalIds);
    }
    onClose();
  };

  const handleDiscard = async () => {
    const confirmed = await confirmDiscardMetadataGroupEdits({
      group,
      editCount: draftCount,
    });
    if (confirmed) {
      if (targetDraftTargets.length > 0) {
        onDiscardTargetDraftBatch?.(targetDraftTargets);
      }
    }
    onClose();
  };

  function formatRemoveGroupLabel(count: number, group: string): string {
    if (count === 0) return `Remove writable ${group} fields…`;
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
    ...(gpsEditPreview && gpsGroup
      ? [
          {
            label: "Edit GPS…",
            onClick: () => {
              onClose();
              onEditGps?.(gpsGroup);
            },
            disabled: gpsEditPreview.blocked !== undefined,
            title: gpsEditPreview.blocked,
          },
        ]
      : []),
    ...(showRemove
      ? [
          {
            label: formatRemoveGroupLabel(removeCount, group),
            onClick: handleRemove,
            disabled: removalPreview.blocked !== undefined,
            title: removalPreview.blocked,
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
  occurrences,
  targetDraftEdits,
  targetDraftPersistence = { status: "ready" },
  onSetExistingOccurrenceDraft,
  onRemoveMetadataFields,
  onApplyGpsTargetDraftBatch,
  onSetNewPropertyDraft,
  onReplaceNewPropertyDraftTarget,
  onDiscardTargetPropertyDraft,
  onDiscardTargetDraftBatch,
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onShowInFileExplorer,
}: Props) {
  const metadata = useMemo(
    () =>
      occurrences === "loading"
        ? undefined
        : schemaMetadataCollectionFromOccurrences(occurrences),
    [occurrences],
  );
  const [detailsSearch, setDetailsSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    id: SchemaDefinitionId;
    originalValue: string;
    draftValue?: string | null;
  } | null>(null);
  const [supplementalContextMenu, setSupplementalContextMenu] = useState<{
    x: number;
    y: number;
    occurrenceToken: string;
  } | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number;
    y: number;
    group: string;
  } | null>(null);
  const [editDialog, setEditDialog] = useState<EditDialogState | null>(null);
  const [editDialogUnavailableMessage, setEditDialogUnavailableMessage] =
    useState<string | null>(null);
  const [showNewPropertyDialog, setShowNewPropertyDialog] = useState(false);
  // Stage 2 of the new-property flow: key picked, now show a TypedValueEditor
  // for that key.  null when no flow is active or we're still on stage 1.
  const [newPropertyTarget, setNewPropertyTarget] =
    useState<NewPropertyTarget | null>(null);
  const [newPropertyDestinationInitial, setNewPropertyDestinationInitial] =
    useState<{ target: NewPropertyTarget; edit: MetadataDraftEdit } | null>(
      null,
    );

  const targetDraftsWritable = targetDraftPersistence.status === "ready";
  const addPropertyUnavailableTitle = targetDraftsWritable
    ? "Add a metadata property"
    : "Add Property is unavailable because target-aware drafts could not be loaded safely. Fix the target-aware draft persistence file, then reopen the folder.";

  useEffect(() => {
    if (targetDraftsWritable) return;
    setShowNewPropertyDialog(false);
    setNewPropertyTarget(null);
    setNewPropertyDestinationInitial(null);
    if (editDialog?.kind === "new-property") {
      setEditDialogUnavailableMessage(
        "Target-draft persistence changed while the New Property editor was open. Nothing was saved.",
      );
    }
    setEditDialog((current) =>
      current?.kind === "new-property" ? null : current,
    );
  }, [editDialog?.kind, targetDraftsWritable]);

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
  const presentationPlan = useMemo(() => {
    const presented: PresentedTargetDraft[] = [];
    if (metadata === undefined || !targetDraftsWritable) return presented;
    for (const entry of Object.values(targetDraftEdits ?? {})) {
      const occurrenceResolution = resolutionForSchema(
        occurrenceResolutionIndex,
        entry.target.schema_id,
      );
      if (entry.target.kind === "NewProperty") {
        const schemaResolution = targetSchemaResolutions.get(
          schemaDefinitionIdToken(entry.target.schema_id),
        );
        if (
          occurrenceResolution.kind === "missing" &&
          schemaResolution?.kind === "unique" &&
          schemaResolution.entry === entry
        ) {
          presented.push({ destination: "ordinary-row", entry });
        }
        continue;
      }
      if (
        occurrences === undefined ||
        occurrences === "loading" ||
        (gpsMemberGroup(entry.target.schema_id) !== null &&
          occurrenceResolution.kind === "multiple")
      ) {
        continue;
      }
      const exact = resolveExactMetadataOccurrence(
        occurrences,
        entry.target.occurrence_id,
      );
      if (exact.kind !== "unique") continue;
      const currentTarget = existingOccurrenceTargetFromOccurrence(
        exact.occurrence,
      );
      if (
        currentTarget.kind !== "targetable" ||
        !metadataDraftTargetEquals(currentTarget.target, entry.target)
      ) {
        continue;
      }
      presented.push(
        occurrenceResolution.kind === "multiple"
          ? {
              destination: "supplemental-row",
              entry: entry as MetadataTargetDraftEntry & {
                target: ExistingOccurrenceTarget;
              },
              occurrence: exact.occurrence,
            }
          : {
              destination: "ordinary-row",
              entry,
              occurrence: exact.occurrence,
            },
      );
    }
    return presented;
  }, [
    occurrences,
    occurrenceResolutionIndex,
    targetDraftEdits,
    targetSchemaResolutions,
    targetDraftsWritable,
  ]);
  const presentedTargetDrafts = useMemo(
    () =>
      presentationPlan
        .filter(
          (
            presented,
          ): presented is Extract<
            PresentedTargetDraft,
            { destination: "ordinary-row" }
          > => presented.destination === "ordinary-row",
        )
        .map(
          (presented) =>
            [
              schemaDefinitionIdToken(presented.entry.target.schema_id),
              presented.entry,
            ] as const,
        ),
    [presentationPlan],
  );
  const presentedExistingOccurrenceDrafts = useMemo(
    () =>
      presentationPlan.flatMap((presented) =>
        presented.destination === "ordinary-row" &&
        presented.entry.target.kind === "ExistingOccurrence" &&
        presented.occurrence
          ? [
              {
                token: schemaDefinitionIdToken(
                  presented.entry.target.schema_id,
                ),
                entry: {
                  ...presented.entry,
                  target: presented.entry.target,
                },
                occurrence: presented.occurrence,
              },
            ]
          : [],
      ),
    [presentationPlan],
  );
  const presentedSupplementalByOccurrence = useMemo(
    () =>
      new Map(
        presentationPlan.flatMap((presented) =>
          presented.destination === "supplemental-row"
            ? [
                [
                  metadataOccurrenceIdToken(
                    presented.entry.target.occurrence_id,
                  ),
                  presented,
                ] as const,
              ]
            : [],
        ),
      ),
    [presentationPlan],
  );
  const presentedExistingBySchema = useMemo(
    () =>
      new Map(
        presentedExistingOccurrenceDrafts.map((presented) => [
          schemaDefinitionIdToken(presented.entry.target.schema_id),
          presented,
        ]),
      ),
    [presentedExistingOccurrenceDrafts],
  );
  const presentedOrdinaryOccurrenceTokens = useMemo(
    () =>
      new Set(
        presentedExistingOccurrenceDrafts.map((presented) =>
          metadataOccurrenceIdToken(presented.entry.target.occurrence_id),
        ),
      ),
    [presentedExistingOccurrenceDrafts],
  );
  const unresolvedTargetDrafts = useMemo(() => {
    const presented = new Set(presentationPlan.map((item) => item.entry));
    return Object.values(targetDraftEdits ?? {}).filter(
      (entry) => !presented.has(entry),
    );
  }, [presentationPlan, targetDraftEdits]);
  const activeNewPropertyDraft = useMemo(
    () =>
      newPropertyTarget === null
        ? undefined
        : Object.values(targetDraftEdits ?? {}).find(
            (entry) =>
              entry.target.kind === "NewProperty" &&
              metadataDraftTargetEquals(entry.target, newPropertyTarget),
          ),
    [newPropertyTarget, targetDraftEdits],
  );
  const effectiveMetadata = useMemo(
    () =>
      metadata === undefined
        ? undefined
        : buildEffectiveMetadataForFile({
            occurrences,
            targetDrafts: targetDraftEdits,
          }),
    [metadata, occurrences, targetDraftEdits],
  );
  const resolvedGps = useMemo(
    () =>
      resolveEffectiveGpsForFile({
        occurrences,
        targetDrafts: targetDraftEdits,
      }),
    [occurrences, targetDraftEdits],
  );

  const draftEdits = useMemo(() => {
    const combined: Record<string, string | null> = {};
    for (const [token, entry] of presentedTargetDrafts) {
      const display = displayStringOfDraft(entry.edit);
      if (display !== undefined) combined[token] = display;
    }
    return combined;
  }, [presentedTargetDrafts]);

  const totalDraftCount = Object.keys(targetDraftEdits ?? {}).length;

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
  const openGroupContextMenu = (event: React.MouseEvent, group: string) => {
    event.preventDefault();
    event.stopPropagation();

    setContextMenu(null);
    setSupplementalContextMenu(null);
    setGroupContextMenu({
      x: event.clientX,
      y: event.clientY,
      group,
    });
  };
  const normalizedDetailsQuery = useMemo(
    () => normalizeListSearchQuery(detailsSearch),
    [detailsSearch],
  );

  const osEntries = useMemo(() => getOsEntries(photo), [photo]);
  const displayIds = useMemo(() => {
    const ids: SchemaDefinitionId[] = [];
    if (metadata !== undefined) {
      for (const entry of Object.values(metadata)) ids.push(entry.id);
    }
    for (const [, entry] of presentedTargetDrafts) {
      ids.push(entry.target.schema_id);
    }
    for (const entry of unresolvedTargetDrafts) {
      ids.push(entry.target.schema_id);
    }
    return ids;
  }, [metadata, presentedTargetDrafts, unresolvedTargetDrafts]);
  const schemaLookupIds = useMemo(
    () =>
      displayIds.filter(
        (id) =>
          !presentedExistingBySchema.has(schemaDefinitionIdToken(id)) &&
          resolutionForSchema(occurrenceResolutionIndex, id).kind !== "unique",
      ),
    [displayIds, occurrenceResolutionIndex, presentedExistingBySchema],
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
    for (const presented of presentedExistingOccurrenceDrafts) {
      if (presented.occurrence.tag_info !== null) {
        result[presented.token] = presented.occurrence.tag_info;
      }
    }
    return result;
  }, [
    displayIds,
    lookedUpDisplayTagInfos,
    occurrenceResolutionIndex,
    presentedExistingOccurrenceDrafts,
  ]);
  const imageGroups = useMemo(() => {
    if (metadata === undefined) return [];

    const combinedMetadata: Record<string, ImageMetadataEntry> = {
      ...metadata,
    };
    for (const [token, entry] of presentedTargetDrafts) {
      const presentedExisting = presentedExistingBySchema.get(token);
      if (presentedExisting) {
        combinedMetadata[token] = {
          ...presentedExisting.occurrence.value,
          id: entry.target.schema_id,
        } as ImageMetadataEntry;
      } else if (metadataGet(metadata, entry.target.schema_id) === undefined) {
        combinedMetadata[token] = {
          kind: "Null",
          id: entry.target.schema_id,
        };
      }
    }
    return groupImageMetadata(combinedMetadata, displayTagInfos);
  }, [
    displayTagInfos,
    occurrenceResolutionIndex,
    presentedTargetDrafts,
    presentedExistingBySchema,
  ]);

  const ordinaryEditResolution = useMemo<
    | { kind: "available"; occurrence: MetadataOccurrence }
    | { kind: "unavailable"; reason: string }
    | null
  >(() => {
    if (editDialog?.kind !== "existing-occurrence") return null;
    if (occurrences === undefined || occurrences === "loading") {
      return {
        kind: "unavailable",
        reason:
          "The exact metadata occurrence is unavailable while authoritative metadata is loading. Nothing was saved.",
      };
    }
    const exact = resolveExactMetadataOccurrence(
      occurrences,
      editDialog.occurrenceId,
    );
    if (exact.kind === "missing") {
      return {
        kind: "unavailable",
        reason:
          "The exact metadata occurrence selected for this editor no longer exists. Nothing was saved.",
      };
    }
    if (exact.kind === "duplicate") {
      return {
        kind: "unavailable",
        reason:
          "The selected occurrence ID is duplicated, so this editor can no longer target it safely. Nothing was saved.",
      };
    }
    if (
      !schemaDefinitionIdEquals(
        exact.occurrence.schema_id,
        editDialog.schemaId,
      ) ||
      exact.occurrence.tag_info === null ||
      !schemaDefinitionIdEquals(
        exact.occurrence.tag_info.id,
        exact.occurrence.schema_id,
      )
    ) {
      return {
        kind: "unavailable",
        reason:
          "The selected occurrence's embedded schema changed, so this editor was closed without saving.",
      };
    }
    const currentTarget = existingOccurrenceTargetFromOccurrence(
      exact.occurrence,
    );
    if (
      currentTarget.kind !== "targetable" ||
      !metadataDraftTargetEquals(currentTarget.target, editDialog.openedTarget)
    ) {
      return {
        kind: "unavailable",
        reason:
          "The selected occurrence's exact write target changed or became unavailable. Nothing was saved.",
      };
    }

    const schemaResolution = resolutionForSchema(
      occurrenceResolutionIndex,
      editDialog.schemaId,
    );
    const supplementalOwnership = resolveSupplementalOccurrenceDraft(
      exact.occurrence,
      targetDraftEdits,
    );
    const isSupplemental =
      schemaResolution.kind === "multiple" ||
      (metadata !== undefined &&
        metadataGet(metadata, editDialog.schemaId) === undefined);
    if (isSupplemental) {
      if (!targetDraftsWritable) {
        return {
          kind: "unavailable",
          reason:
            "Target-aware draft persistence is unavailable, so this editor was closed without saving.",
        };
      }
      if (supplementalOwnership.kind === "none") {
        return { kind: "available", occurrence: exact.occurrence };
      }
      if (
        supplementalOwnership.kind === "target" &&
        metadataDraftTargetEquals(
          supplementalOwnership.entry.target,
          currentTarget.target,
        )
      ) {
        return { kind: "available", occurrence: exact.occurrence };
      }
      return {
        kind: "unavailable",
        reason:
          supplementalOwnership.kind === "blocked"
            ? supplementalOwnership.reason
            : "This supplemental row no longer owns the exact target selected when the editor opened. Nothing was saved.",
      };
    }

    const token = schemaDefinitionIdToken(editDialog.schemaId);
    const presented = presentedExistingBySchema.get(token);
    if (presented) {
      if (
        metadataOccurrenceIdToken(presented.occurrence.id) ===
          metadataOccurrenceIdToken(editDialog.occurrenceId) &&
        metadataDraftTargetEquals(presented.entry.target, currentTarget.target)
      ) {
        return { kind: "available", occurrence: exact.occurrence };
      }
      return {
        kind: "unavailable",
        reason:
          "This ordinary row is now owned by a different exact target. Nothing was saved.",
      };
    }

    const rowDraft = resolveExistingRowDraft(
      editDialog.schemaId,
      schemaResolution,
      targetDraftEdits,
    );
    if (
      schemaResolution.kind === "unique" &&
      metadataOccurrenceIdToken(schemaResolution.occurrence.id) ===
        metadataOccurrenceIdToken(editDialog.occurrenceId) &&
      rowDraft.kind === "none"
    ) {
      return { kind: "available", occurrence: exact.occurrence };
    }
    return {
      kind: "unavailable",
      reason:
        "The ordinary row no longer resolves to the exact occurrence selected when the editor opened. Nothing was saved.",
    };
  }, [
    editDialog,
    occurrenceResolutionIndex,
    occurrences,
    presentedExistingBySchema,
    targetDraftEdits,
    targetDraftsWritable,
  ]);

  const editDialogPropertyId = editDialog
    ? editDialog.kind === "gps-composite"
      ? editDialog.group.latitudeId
      : editDialog.schemaId
    : undefined;
  const editDialogInitialValue = (() => {
    if (!editDialog) return undefined;
    if (editDialog.kind === "gps-composite") {
      return effectiveMetadata
        ? metadataGet(effectiveMetadata, editDialog.group.latitudeId)
        : undefined;
    }
    if (editDialog.kind === "new-property") {
      return editDialog.openedEdit.intent === "Delete"
        ? undefined
        : (editDialog.openedEdit.value ?? undefined);
    }
    if (ordinaryEditResolution?.kind !== "available") return undefined;
    const presented =
      presentedExistingBySchema.get(
        schemaDefinitionIdToken(editDialog.schemaId),
      ) ??
      presentedSupplementalByOccurrence.get(
        metadataOccurrenceIdToken(editDialog.occurrenceId),
      );
    return presented
      ? effectiveExistingDraftValue(
          ordinaryEditResolution.occurrence.value,
          presented.entry.edit,
        )
      : ordinaryEditResolution.occurrence.value;
  })();
  const editDialogRenderKey = editDialog
    ? `${editDialog.kind}:${schemaDefinitionIdToken(editDialogPropertyId!)}:${JSON.stringify(
        {
          occurrence:
            editDialog.kind === "existing-occurrence"
              ? editDialog.occurrenceId
              : null,
          target:
            editDialog.kind === "new-property" ? editDialog.openedTarget : null,
          value: editDialogInitialValue,
        },
      )}`
    : undefined;

  useEffect(() => {
    if (
      editDialog?.kind === "existing-occurrence" &&
      ordinaryEditResolution?.kind === "unavailable"
    ) {
      setEditDialogUnavailableMessage(ordinaryEditResolution.reason);
      setEditDialog(null);
    }
  }, [editDialog, ordinaryEditResolution]);

  const fullGroupForMenu = useMemo(() => {
    if (!groupContextMenu) return null;
    return imageGroups.find((g) => g.prefix === groupContextMenu.group) ?? null;
  }, [groupContextMenu, imageGroups]);

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
    if (metadata === undefined || occurrences === "loading") {
      return [];
    }
    return supplementalResolvedMetadataOccurrences(
      occurrences,
      metadata,
      occurrenceResolutionIndex,
    ).filter(
      (entry) => !presentedOrdinaryOccurrenceTokens.has(entry.identityToken),
    );
  }, [
    metadata,
    occurrences,
    occurrenceResolutionIndex,
    presentedOrdinaryOccurrenceTokens,
  ]);
  const supplementalRows = useMemo(
    () =>
      occurrenceEntries.map((entry, index) => {
        const exactResolution =
          occurrences === undefined || occurrences === "loading"
            ? { kind: "missing" as const }
            : resolveExactMetadataOccurrence(occurrences, entry.occurrence.id);
        const ownership = resolveSupplementalOccurrenceDraft(
          entry.occurrence,
          targetDraftEdits,
        );
        const presented = presentedSupplementalByOccurrence.get(
          entry.identityToken,
        );
        let unavailableReason: string | undefined;
        if (
          entry.schemaId !== undefined &&
          gpsMemberGroup(entry.schemaId) !== null
        ) {
          unavailableReason =
            "GPS supplemental occurrences remain read-only; paired target-aware GPS editing is available only from an ordinary unique row.";
        } else if (exactResolution.kind === "duplicate") {
          unavailableReason =
            "This exact occurrence ID is duplicated and cannot be targeted safely.";
        } else if (exactResolution.kind !== "unique") {
          unavailableReason =
            "This exact occurrence is no longer available and cannot be targeted safely.";
        } else {
          const targetability = existingOccurrenceTargetFromOccurrence(
            entry.occurrence,
          );
          if (targetability.kind === "read-only") {
            unavailableReason = targetability.reason;
          } else if (!targetDraftsWritable) {
            unavailableReason =
              "Target-aware editing is unavailable because target-aware draft persistence did not load safely.";
          } else if (ownership.kind === "blocked") {
            unavailableReason = ownership.reason;
          } else if (ownership.kind === "target" && !presented) {
            unavailableReason =
              "The stored target is unresolved and cannot be overlaid on this occurrence.";
          }
        }
        const targetDraft = presented?.entry;
        const stagedValue = targetDraft
          ? targetDraft.edit.intent === "Delete"
            ? "—"
            : metadataValueToDisplayStringForTag(
                targetDraft.target.schema_id,
                effectiveExistingDraftValue(
                  entry.occurrence.value,
                  targetDraft.edit,
                ),
                entry.occurrence.tag_info,
              )
          : undefined;
        return {
          entry,
          targetDraft,
          unavailableReason,
          stagedValue,
          renderKey:
            exactResolution.kind === "duplicate"
              ? `${entry.identityToken}:duplicate:${index}`
              : entry.identityToken,
        };
      }),
    [
      occurrenceEntries,
      occurrences,
      presentedSupplementalByOccurrence,
      targetDraftEdits,
      targetDraftsWritable,
    ],
  );

  const filteredOccurrenceEntries = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    return supplementalRows.filter(({ entry, targetDraft, stagedValue }) => {
      if (hasEditsFilter && targetDraft === undefined) return false;
      if (!query) return true;
      return haystackContainsNormalized(
        `${entry.searchText}\n${stagedValue ?? ""}`,
        query,
      );
    });
  }, [supplementalRows, normalizedDetailsQuery]);

  const showOsSection = !normalizedDetailsQuery || filteredOsEntries.length > 0;

  const rowDraftResolutionFor = (id: SchemaDefinitionId) => {
    const presented = presentedExistingBySchema.get(
      schemaDefinitionIdToken(id),
    );
    if (presented) {
      return { kind: "target" as const, entry: presented.entry };
    }
    const occurrenceResolution = resolutionForSchema(
      occurrenceResolutionIndex,
      id,
    );
    return resolveExistingRowDraft(id, occurrenceResolution, targetDraftEdits);
  };

  const ordinaryOccurrenceResolutionFor = (
    id: SchemaDefinitionId,
  ): SchemaOccurrenceResolution => {
    const presented = presentedExistingBySchema.get(
      schemaDefinitionIdToken(id),
    );
    return presented
      ? { kind: "unique", occurrence: presented.occurrence }
      : resolutionForSchema(occurrenceResolutionIndex, id);
  };

  const presentedNewPropertyDraftFor = (
    id: SchemaDefinitionId,
  ): (MetadataTargetDraftEntry & { target: NewPropertyTarget }) | undefined => {
    const resolution = targetSchemaResolutions.get(schemaDefinitionIdToken(id));
    if (
      resolution?.kind !== "unique" ||
      resolution.entry.target.kind !== "NewProperty" ||
      !presentedTargetDrafts.some(([, entry]) => entry === resolution.entry)
    ) {
      return undefined;
    }
    return resolution.entry as MetadataTargetDraftEntry & {
      target: NewPropertyTarget;
    };
  };

  const editingUnavailableReasonFor = (
    id: SchemaDefinitionId,
  ): string | undefined => {
    const targetSchemaResolution = targetSchemaResolutions.get(
      schemaDefinitionIdToken(id),
    );
    if (
      targetSchemaResolution?.kind === "unique" &&
      targetSchemaResolution.entry.target.kind === "NewProperty" &&
      presentedTargetDrafts.some(
        ([, entry]) => entry === targetSchemaResolution.entry,
      )
    ) {
      return undefined;
    }
    const draftResolution = rowDraftResolutionFor(id);
    if (draftResolution.kind === "blocked") return draftResolution.reason;
    if (!targetDraftsWritable) {
      return "Target-aware editing is unavailable because target-aware draft persistence did not load safely.";
    }
    const presented = presentedExistingBySchema.get(
      schemaDefinitionIdToken(id),
    );
    if (presented) {
      const targetability = existingOccurrenceTargetFromOccurrence(
        presented.occurrence,
      );
      return targetability.kind === "read-only"
        ? targetability.reason
        : undefined;
    }
    const occurrenceResolution = resolutionForSchema(
      occurrenceResolutionIndex,
      id,
    );
    if (occurrenceResolution.kind === "multiple") {
      return "Several authoritative occurrences share this schema; no occurrence was selected.";
    }
    if (occurrenceResolution.kind === "missing") {
      return occurrences === "loading" || occurrences === undefined
        ? "Authoritative metadata occurrences are loading."
        : "No authoritative occurrence exists for this row.";
    }
    const targetability = existingOccurrenceTargetFromOccurrence(
      occurrenceResolution.occurrence,
    );
    return targetability.kind === "read-only"
      ? targetability.reason
      : undefined;
  };

  const openExactOccurrenceEditor = (occurrence: MetadataOccurrence) => {
    if (occurrence.tag_info === null) return;
    const targetability = existingOccurrenceTargetFromOccurrence(occurrence);
    if (targetability.kind !== "targetable") return;
    setEditDialogUnavailableMessage(null);
    setEditDialog({
      kind: "existing-occurrence",
      schemaId: structuredClone(occurrence.schema_id),
      occurrenceId: structuredClone(occurrence.id),
      openedTarget: targetability.target,
    });
  };

  const openExistingOccurrenceEditor = (schemaId: SchemaDefinitionId) => {
    const presented = presentedExistingBySchema.get(
      schemaDefinitionIdToken(schemaId),
    );
    const schemaResolution = resolutionForSchema(
      occurrenceResolutionIndex,
      schemaId,
    );
    const occurrence =
      presented?.occurrence ??
      (schemaResolution.kind === "unique"
        ? schemaResolution.occurrence
        : undefined);
    if (!occurrence) return;
    openExactOccurrenceEditor(occurrence);
  };

  const currentNewPropertyDraftEntry = (
    target: NewPropertyTarget,
  ): MetadataTargetDraftEntry | undefined =>
    Object.values(targetDraftEdits ?? {}).find(
      (entry) =>
        entry.target.kind === "NewProperty" &&
        metadataDraftTargetEquals(entry.target, target),
    );

  const newPropertyValueEditorIsCurrent = (
    target: NewPropertyTarget,
    openedEdit: MetadataDraftEdit,
  ): boolean => {
    if (!targetDraftsWritable) return false;
    const current = currentNewPropertyDraftEntry(target);
    if (
      current === undefined ||
      !metadataTargetDraftEntryEqualsExact(current, {
        target,
        edit: openedEdit,
      })
    ) {
      return false;
    }
    const info = displayTagInfos[schemaDefinitionIdToken(target.schema_id)];
    if (
      info === undefined ||
      info === null ||
      info === "loading" ||
      !schemaDefinitionIdEquals(info.id, target.schema_id)
    ) {
      return false;
    }
    const schemaTarget = newPropertyDraftTarget(info);
    return (
      schemaTarget.kind === "available" &&
      target.write_target.group7 === schemaTarget.target.write_target.group7 &&
      target.write_target.tag_name ===
        schemaTarget.target.write_target.tag_name &&
      validateFamily1Group(target.write_target.group1) === null
    );
  };

  const openNewPropertyValueEditor = (target: NewPropertyTarget) => {
    const entry = currentNewPropertyDraftEntry(target);
    if (
      entry === undefined ||
      entry.edit.intent === "Delete" ||
      !newPropertyValueEditorIsCurrent(target, entry.edit)
    ) {
      setEditDialogUnavailableMessage(
        "This New Property draft changed or disappeared while the editor was open. Nothing was saved.",
      );
      return;
    }
    setEditDialogUnavailableMessage(null);
    setEditDialog({
      kind: "new-property",
      schemaId: structuredClone(target.schema_id),
      openedTarget: structuredClone(target),
      openedEdit: structuredClone(entry.edit),
    });
  };

  const openGpsCompositeEditor = (group: GpsTagGroup) => {
    if (!targetDraftsWritable) {
      setEditDialogUnavailableMessage(
        "Target-aware GPS editing is unavailable because target-aware draft persistence did not load safely. Nothing was saved.",
      );
      return;
    }
    if (!onApplyGpsTargetDraftBatch) {
      setEditDialogUnavailableMessage(
        "Target-aware GPS editing is unavailable in this view. Nothing was saved.",
      );
      return;
    }
    try {
      const planned = planGpsTargetDraftBatch(
        gpsGroupIds(group).map((id) => ({
          id,
          edit: { intent: "Delete" as const, value: null },
        })),
        occurrences ?? "loading",
        targetDraftEdits,
      );
      setEditDialogUnavailableMessage(null);
      setEditDialog({
        kind: "gps-composite",
        group: structuredClone(group),
        openedTargets: Object.fromEntries(
          planned.map(({ id, target }) => [
            schemaDefinitionIdToken(id),
            structuredClone(target),
          ]),
        ),
        openedDraftTargets: planned.flatMap(({ target }) => {
          const slot = metadataDraftTargetSlotToken(target);
          const current = targetDraftEdits?.[slot];
          return current && metadataDraftTargetEquals(current.target, target)
            ? [structuredClone(target)]
            : [];
        }),
      });
    } catch (error) {
      setEditDialogUnavailableMessage(
        error instanceof Error
          ? error.message
          : "The GPS editor could not capture exact destinations. Nothing was saved.",
      );
    }
  };

  const revalidateGpsEditorTargets = (
    entries: MetadataTargetDraftEntry[],
    openedDraftTargets: MetadataDraftTarget[],
  ): boolean => {
    try {
      for (const openedTarget of openedDraftTargets) {
        const current =
          targetDraftEdits?.[metadataDraftTargetSlotToken(openedTarget)];
        if (
          current === undefined ||
          !metadataDraftTargetEquals(current.target, openedTarget)
        ) {
          throw new Error(
            "A captured GPS draft target changed or disappeared while the editor was open. Nothing was saved.",
          );
        }
      }
      validateGpsTargetDraftEntries(
        entries,
        occurrences ?? "loading",
        targetDraftEdits,
      );
      return true;
    } catch (error) {
      setEditDialogUnavailableMessage(
        error instanceof Error
          ? error.message
          : "The GPS destinations became stale or unavailable. Nothing was saved.",
      );
      return false;
    }
  };
  const activeSupplementalContext = supplementalContextMenu
    ? supplementalRows.find(
        ({ entry }) =>
          entry.identityToken === supplementalContextMenu.occurrenceToken,
      )
    : undefined;

  return (
    <div className="details-pane" data-testid="details-pane">
      <h2
        className="details-pane-title"
        style={{ display: "flex", alignItems: "center" }}
      >
        Properties
        {totalDraftCount > 0 && (
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
              {totalDraftCount} edit
              {totalDraftCount === 1 ? "" : "s"}
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
                  const editCount = totalDraftCount;
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
                const editCount = totalDraftCount;
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
        {metadata === undefined ? (
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
                    onContextMenu={(event) =>
                      openGroupContextMenu(event, group.prefix)
                    }
                  >
                    {group.prefix}
                  </h3>
                  {group.prefix === "GPS" &&
                  resolvedGps.lat !== null &&
                  resolvedGps.lon !== null ? (
                    <GpsMapOverview
                      lat={resolvedGps.lat}
                      lon={resolvedGps.lon}
                      onContextMenu={(event) =>
                        openGroupContextMenu(event, "GPS")
                      }
                    />
                  ) : null}
                  <table className="details-table">
                    <tbody>
                      {group.entries.map((entry) => {
                        const schemaOccurrenceResolution = resolutionForSchema(
                          occurrenceResolutionIndex,
                          entry.id,
                        );
                        const presentedExisting = presentedExistingBySchema.get(
                          entry.identityToken,
                        );
                        const occurrenceResolution: SchemaOccurrenceResolution =
                          presentedExisting
                            ? {
                                kind: "unique",
                                occurrence: presentedExisting.occurrence,
                              }
                            : schemaOccurrenceResolution;
                        const targetResolution = targetSchemaResolutions.get(
                          entry.identityToken,
                        );
                        const rowDraftResolution = rowDraftResolutionFor(
                          entry.id,
                        );
                        const presentedNewProperty =
                          targetResolution?.kind === "unique" &&
                          targetResolution.entry.target.kind ===
                            "NewProperty" &&
                          presentedTargetDrafts.some(
                            ([, candidate]) =>
                              candidate === targetResolution.entry,
                          );
                        const typedDraft = presentedNewProperty
                          ? targetResolution.entry.edit
                          : presentedExisting
                            ? presentedExisting.entry.edit
                            : rowDraftResolution.kind === "target"
                              ? rowDraftResolution.entry.edit
                              : undefined;
                        return (
                          <DetailsImageRow
                            key={entry.identityToken}
                            entry={entry}
                            rawValue={
                              metadata !== undefined
                                ? metadataGet(metadata, entry.id)
                                : undefined
                            }
                            draftValue={draftEdits[entry.identityToken]}
                            typedDraft={typedDraft}
                            occurrenceResolution={occurrenceResolution}
                            searchQuery={detailsSearch}
                            unavailableReason={editingUnavailableReasonFor(
                              entry.id,
                            )}
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
            {unresolvedTargetDrafts.length > 0 && (
              <section
                className="details-section"
                data-testid="details-target-drafts-ambiguous"
              >
                <h3 className="details-section-header">
                  Additional target-aware edits
                </h3>
                <p className="details-section-subtitle">
                  These complete destination-specific drafts cannot be overlaid
                  on one ordinary schema row. They remain separate and are not
                  selected arbitrarily.
                </p>
                <ul data-testid="details-unresolved-target-list">
                  {unresolvedTargetDrafts.map((entry) => (
                    <li
                      key={JSON.stringify(entry.target)}
                      data-testid="details-unresolved-target-item"
                    >
                      <span>
                        {entry.target.kind === "NewProperty"
                          ? `${entry.target.schema_id.table}/${entry.target.schema_id.tag_id} — ${metadataWriteSelector(entry.target.write_target)} — ${displayStringOfDraft(entry.edit) ?? "—"}`
                          : entry.target.kind}
                      </span>{" "}
                      {entry.target.kind === "NewProperty" && (
                        <button
                          className="button button--secondary"
                          disabled={!targetDraftsWritable}
                          onClick={() =>
                            openNewPropertyValueEditor(
                              entry.target as NewPropertyTarget,
                            )
                          }
                        >
                          Edit value…
                        </button>
                      )}{" "}
                      {entry.target.kind === "NewProperty" && (
                        <button
                          className="button button--secondary"
                          disabled={!targetDraftsWritable}
                          onClick={() => {
                            setNewPropertyDestinationInitial(
                              structuredClone({
                                target: entry.target as NewPropertyTarget,
                                edit: entry.edit,
                              }),
                            );
                            setShowNewPropertyDialog(true);
                          }}
                        >
                          Edit destination…
                        </button>
                      )}{" "}
                      <button
                        className="button button--secondary"
                        disabled={!targetDraftsWritable}
                        onClick={() =>
                          onDiscardTargetPropertyDraft?.(entry.target)
                        }
                      >
                        Discard edit
                      </button>
                    </li>
                  ))}
                </ul>
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
                  by the ordinary schema-oriented view.
                </p>
                <table className="details-table">
                  <tbody>
                    {filteredOccurrenceEntries.map(
                      ({
                        entry,
                        targetDraft,
                        unavailableReason,
                        renderKey,
                      }) => (
                        <DetailsOccurrenceRow
                          key={renderKey}
                          entry={entry}
                          searchQuery={detailsSearch}
                          targetDraft={targetDraft}
                          unavailableReason={unavailableReason}
                          onContextMenu={(event) =>
                            setSupplementalContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              occurrenceToken: entry.identityToken,
                            })
                          }
                        />
                      ),
                    )}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}
      </div>

      {metadata !== undefined && (
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

      {editDialogUnavailableMessage && (
        <div
          className="details-editor-unavailable"
          data-testid="details-editor-unavailable"
          role="alert"
        >
          <span>{editDialogUnavailableMessage}</span>
          <button
            className="button button--secondary"
            onClick={() => setEditDialogUnavailableMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {contextMenu && (
        <DetailsRowContextMenu
          contextMenu={contextMenu}
          occurrenceResolution={ordinaryOccurrenceResolutionFor(contextMenu.id)}
          onEdit={() => {
            setEditDialogUnavailableMessage(null);
            const newProperty = presentedNewPropertyDraftFor(contextMenu.id);
            if (newProperty) {
              openNewPropertyValueEditor(newProperty.target);
            } else {
              openExistingOccurrenceEditor(contextMenu.id);
            }
            setContextMenu(null);
          }}
          onEditDestination={(() => {
            const newProperty = presentedNewPropertyDraftFor(contextMenu.id);
            if (!newProperty) return undefined;
            return () => {
              setNewPropertyDestinationInitial(
                structuredClone({
                  target: newProperty.target,
                  edit: newProperty.edit,
                }),
              );
              setShowNewPropertyDialog(true);
              setContextMenu(null);
            };
          })()}
          onEditGps={() => {
            const group = gpsMemberGroup(contextMenu.id);
            if (group) openGpsCompositeEditor(group);
            setContextMenu(null);
          }}
          onDiscard={() => {
            const rowDraftResolution = rowDraftResolutionFor(contextMenu.id);
            const targetResolution = targetSchemaResolutions.get(
              schemaDefinitionIdToken(contextMenu.id),
            );
            if (rowDraftResolution.kind === "target") {
              onDiscardTargetPropertyDraft?.(rowDraftResolution.entry.target);
            } else if (
              targetResolution?.kind === "unique" &&
              targetResolution.entry.target.kind === "NewProperty"
            ) {
              onDiscardTargetPropertyDraft?.(targetResolution.entry.target);
            }
            setContextMenu(null);
          }}
          onRemove={() => {
            const occurrenceResolution = resolutionForSchema(
              occurrenceResolutionIndex,
              contextMenu.id,
            );
            const targetResolution = targetSchemaResolutions.get(
              schemaDefinitionIdToken(contextMenu.id),
            );
            if (
              targetResolution?.kind === "unique" &&
              targetResolution.entry.target.kind === "NewProperty"
            ) {
              onDiscardTargetPropertyDraft?.(targetResolution.entry.target);
            } else if (
              presentedExistingBySchema.has(
                schemaDefinitionIdToken(contextMenu.id),
              )
            ) {
              onSetExistingOccurrenceDraft?.(
                presentedExistingBySchema.get(
                  schemaDefinitionIdToken(contextMenu.id),
                )!.entry.target,
                {
                  value: null,
                  intent: "Delete",
                },
              );
            } else if (occurrenceResolution.kind === "unique") {
              const resolution = existingOccurrenceTargetFromOccurrence(
                occurrenceResolution.occurrence,
              );
              if (resolution.kind === "targetable") {
                onSetExistingOccurrenceDraft?.(resolution.target, {
                  value: null,
                  intent: "Delete",
                });
              }
            }
            setContextMenu(null);
          }}
          editingUnavailableReason={editingUnavailableReasonFor(contextMenu.id)}
          gpsEditingUnavailableReason={(() => {
            const group = gpsMemberGroup(contextMenu.id);
            if (group === null) return undefined;
            return compositeGpsEditingAvailability({
              group,
              occurrences,
              targetDraftEdits,
              targetDraftPersistence,
              callbackAvailable: onApplyGpsTargetDraftBatch !== undefined,
            }).blocked;
          })()}
          onClose={() => setContextMenu(null)}
        />
      )}

      {supplementalContextMenu &&
        activeSupplementalContext &&
        activeSupplementalContext.unavailableReason === undefined && (
          <ContextMenu
            x={supplementalContextMenu.x}
            y={supplementalContextMenu.y}
            options={[
              {
                label: "Edit…",
                onClick: () => {
                  setSupplementalContextMenu(null);
                  openExactOccurrenceEditor(
                    activeSupplementalContext.entry.occurrence,
                  );
                },
              },
              ...(activeSupplementalContext.targetDraft
                ? [
                    {
                      label: "Discard edit",
                      onClick: () => {
                        onDiscardTargetPropertyDraft?.(
                          activeSupplementalContext.targetDraft!.target,
                        );
                        setSupplementalContextMenu(null);
                      },
                    },
                  ]
                : []),
              {
                label: "Remove",
                onClick: () => {
                  const resolution = existingOccurrenceTargetFromOccurrence(
                    activeSupplementalContext.entry.occurrence,
                  );
                  if (resolution.kind === "targetable") {
                    onSetExistingOccurrenceDraft?.(resolution.target, {
                      intent: "Delete",
                      value: null,
                    });
                  }
                  setSupplementalContextMenu(null);
                },
              },
            ]}
            onClose={() => setSupplementalContextMenu(null)}
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
          occurrences={occurrences}
          targetDraftEdits={targetDraftEdits}
          targetDraftPersistence={targetDraftPersistence}
          onEditGps={
            onApplyGpsTargetDraftBatch ? openGpsCompositeEditor : undefined
          }
          onRemoveMetadataFields={onRemoveMetadataFields}
          onDiscardTargetDraftBatch={onDiscardTargetDraftBatch}
          onBlocked={setEditDialogUnavailableMessage}
          onClose={() => setGroupContextMenu(null)}
        />
      )}

      {editDialog &&
        (editDialog.kind !== "existing-occurrence" ||
          ordinaryEditResolution?.kind === "available") && (
          <TypedValueEditor
            key={editDialogRenderKey}
            propertyId={editDialogPropertyId!}
            editorMode={editDialog.kind === "gps-composite" ? "gps" : "single"}
            initialMetadataValue={editDialogInitialValue}
            metadataForFile={effectiveMetadata}
            effectiveGps={
              editDialog.kind === "gps-composite" ? resolvedGps : undefined
            }
            onSaveMetadataBatch={(edits) => {
              // Staged New Property editors use single mode and cannot emit a
              // batch. Composite GPS edits retain their exact-target planner.
              if (editDialog.kind !== "gps-composite") return;
              const entries = edits.flatMap(({ id, edit }) => {
                const target =
                  editDialog.openedTargets[schemaDefinitionIdToken(id)];
                return target
                  ? [{ target: structuredClone(target), edit }]
                  : [];
              });
              if (
                entries.length !== edits.length ||
                !revalidateGpsEditorTargets(
                  entries,
                  editDialog.openedDraftTargets,
                )
              ) {
                return;
              }
              if (onApplyGpsTargetDraftBatch?.(entries)) {
                setEditDialog(null);
              } else {
                setEditDialogUnavailableMessage(
                  "The target-aware GPS batch could not be saved. The editor remains open and nothing was retargeted.",
                );
              }
            }}
            onSaveMetadata={async (edit) => {
              const propertyId = editDialogPropertyId!;
              // A staged New Property value edit always preserves its exact
              // stored target. GPS membership must not redirect it through the
              // GPS target planner.
              if (editDialog.kind === "new-property") {
                if (
                  !newPropertyValueEditorIsCurrent(
                    editDialog.openedTarget,
                    editDialog.openedEdit,
                  )
                ) {
                  setEditDialogUnavailableMessage(
                    "This New Property draft changed or disappeared while the editor was open. Nothing was saved.",
                  );
                  return;
                }
                const saved = await onSetNewPropertyDraft?.(
                  editDialog.openedTarget,
                  edit,
                );
                if (saved) {
                  setEditDialog(null);
                } else {
                  setEditDialogUnavailableMessage(
                    "The New Property value could not be saved. The editor remains open and the destination was not changed.",
                  );
                }
              } else if (gpsMemberGroup(propertyId) !== null) {
                const openedTarget =
                  editDialog.kind === "existing-occurrence"
                    ? editDialog.openedTarget
                    : undefined;
                if (!openedTarget) return;
                const entries = [
                  { target: structuredClone(openedTarget), edit },
                ];
                if (!revalidateGpsEditorTargets(entries, [])) {
                  return;
                }
                if (onApplyGpsTargetDraftBatch?.(entries)) {
                  setEditDialog(null);
                } else {
                  setEditDialogUnavailableMessage(
                    "The exact GPS edit could not be saved. Nothing was retargeted.",
                  );
                }
              } else if (
                editDialog.kind === "existing-occurrence" &&
                ordinaryEditResolution?.kind === "available"
              ) {
                onSetExistingOccurrenceDraft?.(editDialog.openedTarget, edit);
                setEditDialog(null);
              }
            }}
            onCancel={() => setEditDialog(null)}
          />
        )}

      {targetDraftsWritable && showNewPropertyDialog && (
        <NewPropertyDialog
          onSave={async (target) => {
            if (newPropertyDestinationInitial) {
              const moved = await onReplaceNewPropertyDraftTarget?.(
                newPropertyDestinationInitial.target,
                target,
                newPropertyDestinationInitial.edit,
              );
              if (!moved) return;
              setShowNewPropertyDialog(false);
              setNewPropertyDestinationInitial(null);
              return;
            }
            setShowNewPropertyDialog(false);
            setNewPropertyDestinationInitial(null);
            setNewPropertyTarget(target);
          }}
          onCancel={() => {
            setShowNewPropertyDialog(false);
            setNewPropertyDestinationInitial(null);
          }}
          existingOccurrences={
            occurrences === undefined || occurrences === "loading"
              ? undefined
              : occurrences
          }
          filename={photo.filename}
          initialTarget={newPropertyDestinationInitial?.target}
          pendingTargets={Object.values(targetDraftEdits ?? {}).map(
            (entry) => entry.target,
          )}
        />
      )}

      {newPropertyTarget !== null && targetDraftsWritable && (
        <TypedValueEditor
          propertyId={newPropertyTarget.schema_id}
          editorMode="single"
          initialMetadataValue={
            activeNewPropertyDraft?.edit.intent === "Set"
              ? (activeNewPropertyDraft.edit.value ?? undefined)
              : undefined
          }
          metadataForFile={effectiveMetadata}
          onSaveMetadataBatch={async (edits) => {
            const saves: Promise<boolean>[] = [];
            for (const { id, edit } of edits) {
              if (schemaDefinitionIdEquals(id, newPropertyTarget.schema_id)) {
                saves.push(
                  onSetNewPropertyDraft?.(newPropertyTarget, edit) ??
                    Promise.resolve(false),
                );
                continue;
              }
              const info = displayTagInfos[schemaDefinitionIdToken(id)];
              const resolution =
                info && info !== "loading"
                  ? newPropertyDraftTarget(info)
                  : null;
              if (resolution?.kind === "available") {
                saves.push(
                  onSetNewPropertyDraft?.(resolution.target, edit) ??
                    Promise.resolve(false),
                );
              }
            }
            const results = await Promise.all(saves);
            if (results.length > 0 && results.every(Boolean)) {
              setNewPropertyTarget(null);
            } else {
              setEditDialogUnavailableMessage(
                "The New Property value could not be saved. The editor remains open.",
              );
            }
          }}
          onSaveMetadata={async (edit) => {
            const saved = await onSetNewPropertyDraft?.(
              newPropertyTarget,
              edit,
            );
            if (saved) {
              setNewPropertyTarget(null);
            } else {
              setEditDialogUnavailableMessage(
                "The New Property value could not be saved. The editor remains open.",
              );
            }
          }}
          onCancel={() => setNewPropertyTarget(null)}
        />
      )}
    </div>
  );
}
