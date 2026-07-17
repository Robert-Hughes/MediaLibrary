import { useEffect, useMemo, useState } from "react";
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  PhotoInfo,
  ImageMetadataState,
  ImageMetadataOccurrencesState,
  MetadataValue,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataDraftEntryV5,
  TargetDraftPersistenceStateV5,
} from "../types";
import { metadataValueEqual } from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
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
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { buildEffectiveMetadataForFile } from "../utils/effectiveMetadata";
import { metadataGet } from "../utils/metadataCollection";
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
} from "../utils/metadataDraftTarget";
import { metadataOccurrenceIdToken } from "../utils/metadataOccurrenceId";
import { planGpsTargetDraftBatchV5 } from "../gpsTargetDrafts";
import { previewMetadataRemovalTargetsV5 } from "../metadataRemovalTargets";

type ExistingOccurrenceTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;

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
    }
  | {
      kind: "new-property";
      schemaId: SchemaDefinitionId;
      openedTarget?: MetadataDraftTarget;
    };

type PresentedTargetDraft =
  | {
      destination: "ordinary-row";
      entry: MetadataDraftEntryV5;
      occurrence?: MetadataOccurrence;
    }
  | {
      destination: "supplemental-row";
      entry: MetadataDraftEntryV5 & { target: ExistingOccurrenceTarget };
      occurrence: MetadataOccurrence;
    };

interface Props {
  photo: PhotoInfo;
  metadata: ImageMetadataState;
  /** Authoritative occurrences; optional for read-only or direct consumers. */
  occurrences?: ImageMetadataOccurrencesState;
  /** Exact-target drafts for Add Property and unique existing rows. */
  targetDraftEdits?: TargetDraftCollection;
  /** Folder-scoped safety state for the strict schema-v5 persistence file. */
  targetDraftPersistence?: TargetDraftPersistenceStateV5;
  onSetExistingOccurrenceDraft?: (
    occurrenceId: MetadataOccurrenceId,
    edit: MetadataDraftEdit,
  ) => void;
  onRemoveMetadataFieldsV5?: (ids: SchemaDefinitionId[]) => boolean;
  onSetGpsTargetDraftBatch?: (
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => boolean;
  onSetNewPropertyDraft?: (
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ) => void;
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
      // This is only a compatibility aggregate. Never replace it with one
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
  targetDraft?: MetadataDraftEntryV5 & { target: ExistingOccurrenceTarget };
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
            entry.occurrence.tag_info.id,
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
  onEditGps,
  onDiscard,
  onRemove,
  onClose,
  editingUnavailableReason,
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
  editingUnavailableReason?: string;
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
  occurrences,
  targetDraftEdits,
  targetDraftPersistence,
  onRemoveMetadataFieldsV5,
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
  targetDraftPersistence: TargetDraftPersistenceStateV5;
  onRemoveMetadataFieldsV5?: (ids: SchemaDefinitionId[]) => boolean;
  onDiscardTargetDraftBatch?: (targets: MetadataDraftTarget[]) => boolean;
  onBlocked: (message: string) => void;
  onClose: () => void;
}) {
  const group = contextMenu.group;
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
        (resolution.occurrence.tag_info?.writable ?? false)
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
          "Group removal is unavailable because schema-v5 draft persistence did not load safely.",
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
        preview: previewMetadataRemovalTargetsV5({
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

  const removeCount = removalPreview.preview?.affectedCount ?? 0;
  const draftCount = targetDraftTargets.length;
  const showRemove =
    removalIds.length > 0 &&
    (removeCount > 0 || removalPreview.blocked !== undefined);

  useEffect(() => {
    if (!showRemove && draftCount === 0) onClose();
  }, [draftCount, onClose, showRemove]);
  if (!showRemove && draftCount === 0) return null;

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
      onRemoveMetadataFieldsV5?.(removalIds);
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
  metadata,
  occurrences,
  targetDraftEdits,
  targetDraftPersistence = { status: "ready" },
  onSetExistingOccurrenceDraft,
  onRemoveMetadataFieldsV5,
  onSetGpsTargetDraftBatch,
  onSetNewPropertyDraft,
  onDiscardTargetPropertyDraft,
  onDiscardTargetDraftBatch,
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
  const presentationPlan = useMemo(() => {
    const presented: PresentedTargetDraft[] = [];
    if (metadata === "loading" || !targetDraftsWritable) return presented;
    for (const [, schemaResolution] of targetSchemaResolutions) {
      if (schemaResolution.kind !== "unique") continue;
      const entry = schemaResolution.entry;
      const occurrenceResolution = resolutionForSchema(
        occurrenceResolutionIndex,
        entry.target.schema_id,
      );
      if (entry.target.kind === "NewProperty") {
        if (
          occurrenceResolution.kind === "missing" &&
          metadataGet(metadata, entry.target.schema_id) === undefined
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
              entry: entry as MetadataDraftEntryV5 & {
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
    metadata,
    occurrences,
    occurrenceResolutionIndex,
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
  const authoritativeBaseMetadata = useMemo(
    () =>
      metadata === "loading"
        ? undefined
        : overlayUniqueOccurrenceValues(metadata, occurrenceResolutionIndex),
    [metadata, occurrenceResolutionIndex],
  );
  const effectiveMetadata = useMemo(() => {
    if (authoritativeBaseMetadata === undefined) return undefined;
    const effective = buildEffectiveMetadataForFile({
      metadata: authoritativeBaseMetadata,
      occurrences,
      targetDrafts: targetDraftEdits,
    });
    for (const [token, entry] of presentedTargetDrafts) {
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
  }, [
    authoritativeBaseMetadata,
    occurrences,
    targetDraftEdits,
    presentedTargetDrafts,
  ]);
  const resolvedGps = useMemo(
    () =>
      resolveEffectiveGpsForFile({
        metadata: metadata === "loading" ? undefined : metadata,
        occurrences,
        targetDrafts: targetDraftEdits,
      }),
    [metadata, occurrences, targetDraftEdits],
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
    for (const [, entry] of presentedTargetDrafts) {
      ids.push(entry.target.schema_id);
    }
    return ids;
  }, [metadata, occurrenceResolutionIndex, presentedTargetDrafts]);
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
    if (metadata === "loading") return [];

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
    metadata,
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
      exact.occurrence.tag_info === null ||
      !schemaDefinitionIdEquals(
        exact.occurrence.tag_info.id,
        editDialog.schemaId,
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
      (metadata !== "loading" &&
        metadataGet(metadata, editDialog.schemaId) === undefined);
    if (isSupplemental) {
      if (!targetDraftsWritable) {
        return {
          kind: "unavailable",
          reason:
            "Schema-v5 draft persistence is unavailable, so this editor was closed without saving.",
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
    metadata,
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
      const target = resolveTargetDraftByExactSchema(
        targetDraftEdits,
        editDialog.schemaId,
      );
      return target.kind === "unique" &&
        target.entry.target.kind === "NewProperty" &&
        target.entry.edit.intent === "Set"
        ? (target.entry.edit.value ?? undefined)
        : undefined;
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
              "Target-aware editing is unavailable because schema-v5 draft persistence did not load safely.";
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

  const editingUnavailableReasonFor = (
    id: SchemaDefinitionId,
  ): string | undefined => {
    if (gpsMemberGroup(id) !== null && !onSetGpsTargetDraftBatch) {
      return "Target-aware GPS editing is unavailable in this view.";
    }
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
      return "Target-aware editing is unavailable because schema-v5 draft persistence did not load safely.";
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
      schemaId: structuredClone(occurrence.tag_info.id),
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

  const openGpsCompositeEditor = (group: GpsTagGroup) => {
    if (!onSetGpsTargetDraftBatch) {
      setEditDialogUnavailableMessage(
        "Target-aware GPS editing is unavailable in this view. Nothing was saved.",
      );
      return;
    }
    try {
      const planned = planGpsTargetDraftBatchV5(
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
    emittedEdits: Array<{
      id: SchemaDefinitionId;
      edit: MetadataDraftEdit;
    }>,
    openedTargets: Record<string, MetadataDraftTarget>,
    snapshotIds: SchemaDefinitionId[],
  ): boolean => {
    try {
      const emittedBySchema = new Map(
        emittedEdits.map((entry) => [schemaDefinitionIdToken(entry.id), entry]),
      );
      const planned = planGpsTargetDraftBatchV5(
        snapshotIds.map(
          (id) =>
            emittedBySchema.get(schemaDefinitionIdToken(id)) ?? {
              id,
              edit: { intent: "Delete" as const, value: null },
            },
        ),
        occurrences ?? "loading",
        targetDraftEdits,
      );
      const changed = planned.some(({ id, target }) => {
        const opened = openedTargets[schemaDefinitionIdToken(id)];
        return (
          opened === undefined || !metadataDraftTargetEquals(opened, target)
        );
      });
      if (changed) {
        setEditDialogUnavailableMessage(
          "A GPS destination changed while the editor was open. Nothing was saved; reopen the editor to review the current targets.",
        );
        return false;
      }
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
                              typeof metadata === "object"
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
                  Unresolved target-aware edits
                </h3>
                <p className="details-section-subtitle">
                  These drafts do not match one complete authoritative row
                  target. They were not overlaid or reinterpreted by schema.
                </p>
                <ul data-testid="details-unresolved-target-list">
                  {unresolvedTargetDrafts.map((entry) => (
                    <li key={JSON.stringify(entry.target)}>
                      <span>{entry.target.kind}</span>{" "}
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
                  by the schema-keyed compatibility view.
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
            const targetResolution = targetSchemaResolutions.get(
              schemaDefinitionIdToken(contextMenu.id),
            );
            setEditDialogUnavailableMessage(null);
            if (
              targetResolution?.kind === "unique" &&
              targetResolution.entry.target.kind === "NewProperty"
            ) {
              setEditDialog({
                kind: "new-property",
                schemaId: contextMenu.id,
                openedTarget: structuredClone(targetResolution.entry.target),
              });
            } else {
              openExistingOccurrenceEditor(contextMenu.id);
            }
            setContextMenu(null);
          }}
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
              gpsMemberGroup(contextMenu.id) !== null &&
              onSetGpsTargetDraftBatch
            ) {
              onSetGpsTargetDraftBatch([
                {
                  id: contextMenu.id,
                  edit: { value: null, intent: "Delete" },
                },
              ]);
            } else if (
              presentedExistingBySchema.has(
                schemaDefinitionIdToken(contextMenu.id),
              )
            ) {
              onSetExistingOccurrenceDraft?.(
                presentedExistingBySchema.get(
                  schemaDefinitionIdToken(contextMenu.id),
                )!.occurrence.id,
                {
                  value: null,
                  intent: "Delete",
                },
              );
            } else if (occurrenceResolution.kind === "unique") {
              onSetExistingOccurrenceDraft?.(
                occurrenceResolution.occurrence.id,
                {
                  value: null,
                  intent: "Delete",
                },
              );
            }
            setContextMenu(null);
          }}
          editingUnavailableReason={editingUnavailableReasonFor(contextMenu.id)}
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
                  onSetExistingOccurrenceDraft?.(
                    activeSupplementalContext.entry.occurrence.id,
                    { intent: "Delete", value: null },
                  );
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
          onRemoveMetadataFieldsV5={onRemoveMetadataFieldsV5}
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
              if (editDialog.kind !== "gps-composite") return;
              if (
                !revalidateGpsEditorTargets(
                  edits,
                  editDialog.openedTargets,
                  gpsGroupIds(editDialog.group),
                )
              ) {
                return;
              }
              if (onSetGpsTargetDraftBatch?.(edits)) {
                setEditDialog(null);
              } else {
                setEditDialogUnavailableMessage(
                  "The target-aware GPS batch could not be saved. The editor remains open and nothing was retargeted.",
                );
              }
            }}
            onSaveMetadata={(edit) => {
              const propertyId = editDialogPropertyId!;
              if (gpsMemberGroup(propertyId) !== null) {
                const openedTarget =
                  editDialog.kind === "existing-occurrence"
                    ? editDialog.openedTarget
                    : editDialog.kind === "new-property"
                      ? editDialog.openedTarget
                      : undefined;
                if (
                  openedTarget &&
                  !revalidateGpsEditorTargets(
                    [{ id: propertyId, edit }],
                    {
                      [schemaDefinitionIdToken(propertyId)]: openedTarget,
                    },
                    [propertyId],
                  )
                ) {
                  return;
                }
                if (onSetGpsTargetDraftBatch?.([{ id: propertyId, edit }])) {
                  setEditDialog(null);
                } else {
                  setEditDialogUnavailableMessage(
                    "The exact GPS edit could not be saved. Nothing was retargeted.",
                  );
                }
              } else if (editDialog.kind === "new-property") {
                onSetNewPropertyDraft?.(editDialog.schemaId, edit);
                setEditDialog(null);
              } else if (
                editDialog.kind === "existing-occurrence" &&
                ordinaryEditResolution?.kind === "available"
              ) {
                onSetExistingOccurrenceDraft?.(editDialog.occurrenceId, edit);
                setEditDialog(null);
              }
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
