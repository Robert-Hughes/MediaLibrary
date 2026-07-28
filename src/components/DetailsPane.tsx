import { useEffect, useMemo, useState } from "react";
import type {
  MetadataDraftEdit,
  FileInfo,
  FileMetadataOccurrencesState,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataTargetDraftEntry,
  TargetDraftPersistenceState,
} from "../types";
import {
  metadataTargetDraftEntryEqualsExact,
  type TargetDraftCollection,
} from "../targetDraftEdits";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { TypedValueEditor } from "./editors/TypedValueEditor";
import { useTagInfos } from "../hooks/useTagInfo";
import { DatatypeBadge } from "./DatatypeBadge";
import { gpsMemberGroup, type GpsTagGroup } from "../metadata/tag_overrides";
import { NewPropertyDialog } from "./NewPropertyDialog";
import { getOsEntries } from "../utils/detailsPaneHelpers";
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
import { GpsMapOverview } from "./GpsMapOverview";
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import {
  applyMetadataDraftEditExactly,
  buildEffectiveMetadataForFile,
} from "../utils/effectiveMetadata";
import { metadataGet } from "../utils/metadataCollection";
import { schemaMetadataCollectionFromOccurrences } from "../utils/schemaMetadataProjection";
import { resolveExactMetadataOccurrence } from "../utils/metadataOccurrences";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "../utils/metadataDraftTarget";
import { validateFamily1Group } from "../utils/metadataWriteTarget";
import {
  planGpsTargetDraftBatch,
  validateGpsTargetDraftEntries,
} from "../gpsTargetDrafts";
import { planMetadataTargetRemovals } from "../metadataRemovalTargets";
import {
  buildOccurrenceDetailsPresentation,
  type OccurrenceDetailsRow,
} from "../details/occurrenceDetailsPresentation";
import { OccurrenceMetadataRow } from "./details/OccurrenceMetadataRow";
import { OccurrenceMetadataRowContextMenu } from "./details/OccurrenceMetadataRowContextMenu";
import { metadataDraftTargetToken } from "../utils/metadataDraftTarget";

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
      kind: "gps-group";
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

interface Props {
  file: FileInfo;
  /** Authoritative occurrences are the sole metadata state. */
  occurrences: FileMetadataOccurrencesState;
  /** Exact-target drafts for New Property and exact existing occurrence rows. */
  targetDraftEdits?: TargetDraftCollection;
  /** Folder-scoped safety state for the strict target-aware persistence file. */
  targetDraftPersistence?: TargetDraftPersistenceState;
  onSetExistingOccurrenceDraft?: (
    target: ExistingOccurrenceTarget,
    edit: MetadataDraftEdit,
  ) => void;
  onRemoveMetadataTargets?: (targets: MetadataDraftTarget[]) => boolean;
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
   * Trigger the AI-description flow for this file. Wired by App so the
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
   * Reveal this file in the host file manager. Same backend pathway as
   * the list-view context menu's "Show in File Explorer" entry — the
   * App-level callback owns the index/path lookup so DetailsPane stays
   * agnostic about how the file is addressed.
   */
  onShowInFileExplorer?: () => void;
  /** Open this file in the app-level full map view. */
  onOpenFullMap?: () => void;
}

function detailsRowMatchesSearch(
  label: string,
  value: string,
  friendlyName: string,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(
    `${label}\n${value}\n${friendlyName}`,
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

function groupedGpsEditingAvailability({
  group,
  occurrences,
  targetDraftEdits,
  targetDraftPersistence,
  callbackAvailable,
  expectedTarget,
}: {
  group: GpsTagGroup;
  occurrences: FileMetadataOccurrencesState | undefined;
  targetDraftEdits: TargetDraftCollection | undefined;
  targetDraftPersistence: TargetDraftPersistenceState;
  callbackAvailable: boolean;
  expectedTarget?: MetadataDraftTarget;
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
    const planned = planGpsTargetDraftBatch(
      gpsGroupIds(group).map((id) => ({
        id,
        edit: { intent: "Delete" as const, value: null },
      })),
      occurrences ?? "loading",
      targetDraftEdits,
    );
    if (
      expectedTarget !== undefined &&
      !planned.some(({ target }) =>
        metadataDraftTargetEquals(target, expectedTarget),
      )
    ) {
      return {
        blocked:
          "The selected GPS draft destination is not the destination the grouped editor would edit. Nothing was saved.",
      };
    }
    validateGpsTargetDraftEntries(
      planned,
      occurrences ?? "loading",
      targetDraftEdits,
    );
    return {};
  } catch (error) {
    return { blocked: error instanceof Error ? error.message : String(error) };
  }
}

function rowSchemaId(row: OccurrenceDetailsRow): SchemaDefinitionId {
  switch (row.kind) {
    case "ExistingOccurrenceRow":
      return row.occurrence.schema_id;
    case "NewPropertyRow":
    case "MissingOccurrenceDraftRow":
      return row.target.schema_id;
  }
}

function DetailsGroupContextMenu({
  contextMenu,
  occurrences,
  targetDraftEdits,
  targetDraftPersistence,
  onEditGps,
  onRemoveMetadataTargets,
  onDiscardTargetDraftBatch,
  onBlocked,
  onClose,
}: {
  contextMenu: {
    x: number;
    y: number;
    group: string;
    rows: OccurrenceDetailsRow[];
  };
  occurrences: FileMetadataOccurrencesState | undefined;
  targetDraftEdits: TargetDraftCollection | undefined;
  targetDraftPersistence: TargetDraftPersistenceState;
  onEditGps?: (group: GpsTagGroup) => void;
  onRemoveMetadataTargets?: (targets: MetadataDraftTarget[]) => boolean;
  onDiscardTargetDraftBatch?: (targets: MetadataDraftTarget[]) => boolean;
  onBlocked: (message: string) => void;
  onClose: () => void;
}) {
  const group = contextMenu.group;
  const gpsGroup = useMemo(() => {
    if (group !== "GPS") return null;
    for (const row of contextMenu.rows) {
      const candidate = gpsMemberGroup(rowSchemaId(row));
      if (candidate !== null) return candidate;
    }
    return null;
  }, [contextMenu.rows, group]);
  const removalTargets = useMemo(
    () =>
      contextMenu.rows.flatMap((row) =>
        row.removalTarget ? [structuredClone(row.removalTarget)] : [],
      ),
    [contextMenu.rows],
  );
  const targetDraftTargets = useMemo(() => {
    const byTarget = new Map<string, MetadataDraftTarget>();
    for (const row of contextMenu.rows) {
      for (const target of row.draftTargets) {
        byTarget.set(metadataDraftTargetToken(target), structuredClone(target));
      }
    }
    return Array.from(byTarget.values());
  }, [contextMenu.rows]);

  const removalPreview = useMemo<
    | { blocked: string }
    | {
        affectedCount: number;
        existingFieldsToDelete: number;
        stagedCreationsToCancel: number;
      }
  >(() => {
    if (targetDraftPersistence.status !== "ready") {
      return {
        blocked:
          "Group removal is unavailable because target-aware draft persistence did not load safely.",
      };
    }
    if (!Array.isArray(occurrences)) {
      return {
        blocked:
          "Authoritative metadata occurrences are still loading. Retry after this file has finished loading.",
      };
    }
    if (removalTargets.length === 0) {
      return {
        affectedCount: 0,
        existingFieldsToDelete: 0,
        stagedCreationsToCancel: 0,
      };
    }
    try {
      const plan = planMetadataTargetRemovals({
        targets: removalTargets,
        occurrences,
        targetDrafts: targetDraftEdits,
      });
      return {
        affectedCount: plan.upserts.length + plan.deletes.length,
        existingFieldsToDelete: plan.upserts.length,
        stagedCreationsToCancel: plan.deletes.length,
      };
    } catch (error) {
      return {
        blocked: error instanceof Error ? error.message : String(error),
      };
    }
  }, [
    occurrences,
    removalTargets,
    targetDraftEdits,
    targetDraftPersistence.status,
  ]);

  const gpsEditPreview = useMemo<null | { blocked?: string }>(() => {
    if (gpsGroup === null) return null;
    return groupedGpsEditingAvailability({
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
  const removeCount =
    "affectedCount" in removalPreview ? removalPreview.affectedCount : 0;
  const draftCount = targetDraftTargets.length;
  const showEditGps = gpsEditPreview !== null;
  const showRemove =
    removalTargets.length > 0 &&
    (removeCount > 0 || "blocked" in removalPreview);

  useEffect(() => {
    if (!showEditGps && !showRemove && draftCount === 0) onClose();
  }, [draftCount, onClose, showEditGps, showRemove]);
  if (!showEditGps && !showRemove && draftCount === 0) return null;

  const handleRemove = async () => {
    if ("blocked" in removalPreview) {
      onBlocked(removalPreview.blocked);
      onClose();
      return;
    }
    const confirmed = await confirmRemoveMetadataGroupFields({
      group,
      existingFieldsToDelete: removalPreview.existingFieldsToDelete,
      stagedCreationsToCancel: removalPreview.stagedCreationsToCancel,
    });
    if (confirmed) onRemoveMetadataTargets?.(removalTargets);
    onClose();
  };

  const handleDiscard = async () => {
    const confirmed = await confirmDiscardMetadataGroupEdits({
      group,
      editCount: draftCount,
    });
    if (confirmed && targetDraftTargets.length > 0) {
      onDiscardTargetDraftBatch?.(targetDraftTargets);
    }
    onClose();
  };

  const formatRemoveGroupLabel = (count: number, name: string): string => {
    if (count === 0) return `Remove writable ${name} fields…`;
    if (count === 1) return `Remove 1 writable ${name} field…`;
    return `Remove all ${count} writable ${name} fields…`;
  };
  const formatDiscardGroupLabel = (count: number, name: string): string =>
    count === 1
      ? `Discard 1 ${name} edit…`
      : `Discard all ${count} ${name} edits…`;

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
            disabled: "blocked" in removalPreview,
            title:
              "blocked" in removalPreview ? removalPreview.blocked : undefined,
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
  file,
  occurrences,
  targetDraftEdits,
  targetDraftPersistence = { status: "ready" },
  onSetExistingOccurrenceDraft,
  onRemoveMetadataTargets,
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
  onOpenFullMap,
}: Props) {
  const metadata = useMemo(
    () =>
      !Array.isArray(occurrences)
        ? undefined
        : schemaMetadataCollectionFromOccurrences(occurrences),
    [occurrences],
  );
  const [detailsSearch, setDetailsSearch] = useState("");
  const [rowContextMenu, setRowContextMenu] = useState<{
    x: number;
    y: number;
    rowKey: string;
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
  const totalDraftCount = Object.keys(targetDraftEdits ?? {}).length;
  const openGroupContextMenu = (event: React.MouseEvent, group: string) => {
    event.preventDefault();
    event.stopPropagation();
    setRowContextMenu(null);
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

  const osEntries = useMemo(() => getOsEntries(file), [file]);
  const displayIds = useMemo(() => {
    const byToken = new Map<string, SchemaDefinitionId>();
    if (metadata !== undefined) {
      for (const entry of Object.values(metadata)) {
        byToken.set(
          schemaDefinitionIdToken(entry.id),
          structuredClone(entry.id),
        );
      }
    }
    if (Array.isArray(occurrences)) {
      for (const occurrence of occurrences) {
        byToken.set(
          schemaDefinitionIdToken(occurrence.schema_id),
          structuredClone(occurrence.schema_id),
        );
      }
    }
    for (const entry of Object.values(targetDraftEdits ?? {})) {
      byToken.set(
        schemaDefinitionIdToken(entry.target.schema_id),
        structuredClone(entry.target.schema_id),
      );
    }
    return Array.from(byToken.values());
  }, [metadata, occurrences, targetDraftEdits]);
  const embeddedTagInfos = useMemo(() => {
    const result: Record<string, MetadataOccurrence["tag_info"]> = {};
    if (!Array.isArray(occurrences)) return result;
    for (const occurrence of occurrences) {
      if (occurrence.tag_info !== null) {
        result[schemaDefinitionIdToken(occurrence.schema_id)] =
          occurrence.tag_info;
      }
    }
    return result;
  }, [occurrences]);
  const lookupIds = useMemo(
    () =>
      displayIds.filter(
        (id) => embeddedTagInfos[schemaDefinitionIdToken(id)] === undefined,
      ),
    [displayIds, embeddedTagInfos],
  );
  const lookedUpDisplayTagInfos = useTagInfos(lookupIds);
  const displayTagInfos = useMemo(
    () => ({ ...lookedUpDisplayTagInfos, ...embeddedTagInfos }),
    [embeddedTagInfos, lookedUpDisplayTagInfos],
  );
  const occurrencePresentation = useMemo(() => {
    const tagInfos = Object.fromEntries(
      Object.entries(displayTagInfos).flatMap(([token, info]) =>
        info && info !== "loading" ? [[token, info] as const] : [],
      ),
    );
    return buildOccurrenceDetailsPresentation({
      occurrences: Array.isArray(occurrences) ? occurrences : [],
      targetDrafts: targetDraftEdits,
      tagInfos,
    });
  }, [displayTagInfos, occurrences, targetDraftEdits]);
  const filteredOccurrenceGroups = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (!query && !hasEditsFilter) return occurrencePresentation.groups;
    return occurrencePresentation.groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => {
          if (hasEditsFilter && row.draftTargets.length === 0) return false;
          return !query || haystackContainsNormalized(row.searchText, query);
        }),
      }))
      .filter((group) => group.rows.length > 0);
  }, [normalizedDetailsQuery, occurrencePresentation.groups]);
  const allOccurrenceRows = useMemo(
    () => occurrencePresentation.groups.flatMap((group) => group.rows),
    [occurrencePresentation.groups],
  );

  const existingOccurrenceEditResolution = useMemo<
    | { kind: "available"; occurrence: MetadataOccurrence }
    | { kind: "unavailable"; reason: string }
    | null
  >(() => {
    if (editDialog?.kind !== "existing-occurrence") return null;
    if (!Array.isArray(occurrences)) {
      return {
        kind: "unavailable",
        reason:
          "The exact metadata occurrence is unavailable while authoritative metadata is loading. Nothing was saved.",
      };
    }
    if (!targetDraftsWritable) {
      return {
        kind: "unavailable",
        reason:
          "Target-aware draft persistence is unavailable, so this editor was closed without saving.",
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
    const owner =
      targetDraftEdits?.[metadataDraftTargetSlotToken(editDialog.openedTarget)];
    if (
      owner &&
      !metadataDraftTargetEquals(owner.target, editDialog.openedTarget)
    ) {
      return {
        kind: "unavailable",
        reason:
          "A stale complete target now owns this occurrence slot. Nothing was saved or redirected.",
      };
    }
    return { kind: "available", occurrence: exact.occurrence };
  }, [editDialog, occurrences, targetDraftEdits, targetDraftsWritable]);

  const editDialogPropertyId = editDialog
    ? editDialog.kind === "gps-group"
      ? editDialog.group.latitudeId
      : editDialog.schemaId
    : undefined;
  const editDialogInitialValue = (() => {
    if (!editDialog) return undefined;
    if (editDialog.kind === "gps-group") {
      return effectiveMetadata
        ? metadataGet(effectiveMetadata, editDialog.group.latitudeId)
        : undefined;
    }
    if (editDialog.kind === "new-property") {
      return editDialog.openedEdit.intent === "Delete"
        ? undefined
        : (editDialog.openedEdit.value ?? undefined);
    }
    if (existingOccurrenceEditResolution?.kind !== "available") {
      return undefined;
    }
    const owner =
      targetDraftEdits?.[metadataDraftTargetSlotToken(editDialog.openedTarget)];
    if (
      !owner ||
      !metadataDraftTargetEquals(owner.target, editDialog.openedTarget) ||
      owner.edit.intent === "Delete"
    ) {
      return existingOccurrenceEditResolution.occurrence.value;
    }
    const applied = applyMetadataDraftEditExactly(
      existingOccurrenceEditResolution.occurrence.value,
      owner.edit,
      existingOccurrenceEditResolution.occurrence.tag_info?.kind,
    );
    return applied.applied
      ? applied.value
      : existingOccurrenceEditResolution.occurrence.value;
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
    if (editDialog?.kind !== "existing-occurrence") return;
    if (existingOccurrenceEditResolution?.kind === "unavailable") {
      setEditDialogUnavailableMessage(existingOccurrenceEditResolution.reason);
      setEditDialog(null);
      return;
    }
    if (existingOccurrenceEditResolution?.kind !== "available") return;
    const owner =
      targetDraftEdits?.[metadataDraftTargetSlotToken(editDialog.openedTarget)];
    if (
      !owner ||
      !metadataDraftTargetEquals(owner.target, editDialog.openedTarget)
    ) {
      return;
    }
    const applied = applyMetadataDraftEditExactly(
      existingOccurrenceEditResolution.occurrence.value,
      owner.edit,
      existingOccurrenceEditResolution.occurrence.tag_info?.kind,
    );
    if (!applied.applied) {
      setEditDialogUnavailableMessage(
        "The persisted staged operation cannot be previewed safely and must be discarded or replaced before editing.",
      );
      setEditDialog(null);
    }
  }, [editDialog, existingOccurrenceEditResolution, targetDraftEdits]);

  const fullGroupForMenu = useMemo(() => {
    if (!groupContextMenu) return null;
    return (
      occurrencePresentation.groups.find(
        (group) => group.name === groupContextMenu.group,
      ) ?? null
    );
  }, [groupContextMenu, occurrencePresentation.groups]);
  const filteredOsEntries = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (hasEditsFilter) return [];
    if (!query) return osEntries;
    return osEntries.filter(([label, value, key]) => {
      return detailsRowMatchesSearch(label, value, key, query);
    });
  }, [osEntries, normalizedDetailsQuery]);

  const showOsSection = !normalizedDetailsQuery || filteredOsEntries.length > 0;

  const openExactOccurrenceEditor = (occurrence: MetadataOccurrence) => {
    if (occurrence.tag_info === null) return;
    const targetability = existingOccurrenceTargetFromOccurrence(occurrence);
    if (targetability.kind !== "targetable") return;
    const owner =
      targetDraftEdits?.[metadataDraftTargetSlotToken(targetability.target)];
    if (
      owner &&
      metadataDraftTargetEquals(owner.target, targetability.target)
    ) {
      const applied = applyMetadataDraftEditExactly(
        occurrence.value,
        owner.edit,
        occurrence.tag_info.kind,
      );
      if (!applied.applied) {
        setEditDialogUnavailableMessage(
          "The persisted staged operation cannot be previewed safely and must be discarded or replaced before editing.",
        );
        return;
      }
    }
    setEditDialogUnavailableMessage(null);
    setEditDialog({
      kind: "existing-occurrence",
      schemaId: structuredClone(occurrence.schema_id),
      occurrenceId: structuredClone(occurrence.id),
      openedTarget: targetability.target,
    });
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

  const openGroupedGpsEditor = (group: GpsTagGroup) => {
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
      validateGpsTargetDraftEntries(
        planned,
        occurrences ?? "loading",
        targetDraftEdits,
      );
      setEditDialogUnavailableMessage(null);
      setEditDialog({
        kind: "gps-group",
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
  const activeRowContext = rowContextMenu
    ? allOccurrenceRows.find((row) => row.key === rowContextMenu.rowKey)
    : undefined;
  const activeRowGpsGroup = activeRowContext
    ? gpsMemberGroup(rowSchemaId(activeRowContext))
    : null;
  const rowCanOpenContextMenu = (row: OccurrenceDetailsRow): boolean => {
    if (gpsMemberGroup(rowSchemaId(row)) !== null) return true;
    if (!targetDraftsWritable) return false;
    if (row.kind !== "ExistingOccurrenceRow") {
      return row.draftTargets.length > 0;
    }
    if (row.draftTargets.length > 0) return true;
    return (
      !row.duplicateOccurrenceId &&
      row.staleDraft === null &&
      row.targetability.kind === "targetable"
    );
  };
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
                    target: "this file",
                    fileCount: 1,
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
                  scope: "this file",
                });
                if (confirmed) onDiscardAllEdits();
              }}
              title="Discard all edits for this file"
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
            <div
              className="details-section-scroll"
              data-testid="details-section-scroll-os"
            >
              <table className="details-table">
                <tbody>
                  {filteredOsEntries.map(([label, value]) => (
                    <tr
                      key={label}
                      className="details-row"
                      data-testid="details-row"
                    >
                      <td className="details-key">
                        <HighlightedText
                          text={label}
                          searchQuery={detailsSearch}
                        />
                      </td>
                      <DetailsValueCell
                        originalValue={value}
                        draftValue={undefined}
                        searchQuery={detailsSearch}
                        readOnly
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Image Metadata */}
        {occurrences === "failed" ? (
          <section
            className="details-section"
            data-testid="details-section-failed"
          >
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-empty">
              Metadata could not be loaded for this file.
            </div>
          </section>
        ) : metadata === undefined ? (
          <section
            className="details-section"
            data-testid="details-section-loading"
          >
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-loading">Loading metadata…</div>
          </section>
        ) : filteredOccurrenceGroups.length === 0 ? (
          <section
            className="details-section"
            data-testid="details-section-empty"
          >
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-empty">No image metadata available</div>
          </section>
        ) : (
          filteredOccurrenceGroups.map((group) => (
            <section
              className="details-section"
              key={group.name}
              data-testid={`details-section-${group.name}`}
            >
              <h3
                className="details-section-header"
                onContextMenu={(event) =>
                  openGroupContextMenu(event, group.name)
                }
              >
                {group.name}
              </h3>
              <div
                className="details-section-scroll"
                data-testid={`details-section-scroll-${group.name}`}
              >
                {group.name === "GPS" &&
                resolvedGps.lat !== null &&
                resolvedGps.lon !== null ? (
                  <GpsMapOverview
                    lat={resolvedGps.lat}
                    lon={resolvedGps.lon}
                    onOpenFullMap={onOpenFullMap}
                    onContextMenu={(event) =>
                      openGroupContextMenu(event, "GPS")
                    }
                  />
                ) : null}
                <table className="details-table">
                  <tbody>
                    {group.rows.map((row) => (
                      <OccurrenceMetadataRow
                        key={row.key}
                        row={row}
                        searchQuery={detailsSearch}
                        forceReadOnly={!targetDraftsWritable}
                        forceReadOnlyReason={
                          !targetDraftsWritable
                            ? "Target-aware draft persistence did not load safely."
                            : undefined
                        }
                        onContextMenu={(event) => {
                          setRowContextMenu(null);
                          if (!rowCanOpenContextMenu(row)) return;
                          setRowContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            rowKey: row.key,
                          });
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
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

      {rowContextMenu && activeRowContext && (
        <OccurrenceMetadataRowContextMenu
          x={rowContextMenu.x}
          y={rowContextMenu.y}
          row={activeRowContext}
          onEdit={(() => {
            switch (activeRowContext.kind) {
              case "ExistingOccurrenceRow":
                return targetDraftsWritable
                  ? () => {
                      openExactOccurrenceEditor(activeRowContext.occurrence);
                      setRowContextMenu(null);
                    }
                  : undefined;
              case "NewPropertyRow":
                return () => {
                  openNewPropertyValueEditor(activeRowContext.target);
                  setRowContextMenu(null);
                };
              case "MissingOccurrenceDraftRow":
                return undefined;
            }
          })()}
          onEditDestination={
            activeRowContext.kind === "NewPropertyRow" && targetDraftsWritable
              ? () => {
                  setNewPropertyDestinationInitial(
                    structuredClone({
                      target: activeRowContext.target,
                      edit: activeRowContext.edit,
                    }),
                  );
                  setShowNewPropertyDialog(true);
                  setRowContextMenu(null);
                }
              : undefined
          }
          onEditGps={
            activeRowGpsGroup !== null
              ? () => {
                  openGroupedGpsEditor(activeRowGpsGroup);
                  setRowContextMenu(null);
                }
              : undefined
          }
          gpsEditingUnavailableReason={(() => {
            if (activeRowGpsGroup === null) return undefined;
            return groupedGpsEditingAvailability({
              group: activeRowGpsGroup,
              occurrences,
              targetDraftEdits,
              targetDraftPersistence,
              callbackAvailable: onApplyGpsTargetDraftBatch !== undefined,
              expectedTarget:
                activeRowContext.kind === "ExistingOccurrenceRow"
                  ? undefined
                  : activeRowContext.target,
            }).blocked;
          })()}
          onDiscard={
            targetDraftsWritable && activeRowContext.draftTargets.length > 0
              ? () => {
                  if (activeRowContext.draftTargets.length === 1) {
                    onDiscardTargetPropertyDraft?.(
                      activeRowContext.draftTargets[0],
                    );
                  } else {
                    onDiscardTargetDraftBatch?.(activeRowContext.draftTargets);
                  }
                  setRowContextMenu(null);
                }
              : undefined
          }
          onRemove={
            targetDraftsWritable && activeRowContext.removalTarget
              ? () => {
                  const removalTarget = activeRowContext.removalTarget;
                  if (removalTarget === null) return;
                  if (onRemoveMetadataTargets) {
                    onRemoveMetadataTargets([removalTarget]);
                  } else if (
                    activeRowContext.kind === "ExistingOccurrenceRow" &&
                    removalTarget.kind === "ExistingOccurrence"
                  ) {
                    onSetExistingOccurrenceDraft?.(removalTarget, {
                      intent: "Delete",
                      value: null,
                    });
                  } else if (activeRowContext.kind === "NewPropertyRow") {
                    onDiscardTargetPropertyDraft?.(removalTarget);
                  }
                  setRowContextMenu(null);
                }
              : undefined
          }
          onClose={() => setRowContextMenu(null)}
        />
      )}

      {groupContextMenu && fullGroupForMenu && (
        <DetailsGroupContextMenu
          contextMenu={{
            x: groupContextMenu.x,
            y: groupContextMenu.y,
            group: groupContextMenu.group,
            rows: fullGroupForMenu.rows,
          }}
          occurrences={occurrences}
          targetDraftEdits={targetDraftEdits}
          targetDraftPersistence={targetDraftPersistence}
          onEditGps={
            onApplyGpsTargetDraftBatch ? openGroupedGpsEditor : undefined
          }
          onRemoveMetadataTargets={onRemoveMetadataTargets}
          onDiscardTargetDraftBatch={onDiscardTargetDraftBatch}
          onBlocked={setEditDialogUnavailableMessage}
          onClose={() => setGroupContextMenu(null)}
        />
      )}

      {editDialog &&
        (editDialog.kind !== "existing-occurrence" ||
          existingOccurrenceEditResolution?.kind === "available") && (
          <TypedValueEditor
            key={editDialogRenderKey}
            propertyId={editDialogPropertyId!}
            editorMode={editDialog.kind === "gps-group" ? "gps" : "single"}
            initialMetadataValue={editDialogInitialValue}
            metadataForFile={effectiveMetadata}
            effectiveGps={
              editDialog.kind === "gps-group" ? resolvedGps : undefined
            }
            onSaveMetadataBatch={(edits) => {
              // Staged New Property editors use single mode and cannot emit a
              // batch. Grouped GPS edits retain their exact-target planner.
              if (editDialog.kind !== "gps-group") return;
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
                existingOccurrenceEditResolution?.kind === "available"
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
            occurrences === undefined || !Array.isArray(occurrences)
              ? undefined
              : occurrences
          }
          filename={file.filename}
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
