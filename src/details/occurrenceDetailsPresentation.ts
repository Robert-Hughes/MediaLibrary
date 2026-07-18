import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataTargetDraftEntry,
  MetadataValue,
  MetadataWriteTarget,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  displayStringOfMetadataDraft,
  metadataValueToDisplayString,
  metadataValueToDisplayStringForTag,
} from "../draft";
import type { TargetDraftCollection } from "../targetDraftEdits";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetToken,
} from "../utils/metadataDraftTarget";
import {
  formatMetadataOccurrenceIdForDiagnostics,
  metadataOccurrenceIdToken,
} from "../utils/metadataOccurrenceId";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";
import { metadataWriteSelector } from "../utils/metadataWriteTarget";
import { applyMetadataDraftEditExactly } from "../utils/effectiveMetadata";
import {
  classifyNewPropertyDestination,
  type NewPropertyDestinationSafety,
} from "../utils/newPropertyDestinationSafety";

export type OccurrenceDetailsGroupSource =
  "observed-selector" | "tag-info" | "schema-table-fallback" | "write-target";

export type OccurrenceDetailsRowStatusCode =
  | "current"
  | "edited"
  | "read-only"
  | "stale-target"
  | "duplicate-occurrence-id"
  | "new"
  | "destination-occupied"
  | "pending-target-conflict"
  | "destination-unknown"
  | "preview-unsupported"
  | "missing-occurrence"
  | "conflicting-targets";

export interface OccurrenceDetailsRowStatus {
  code: OccurrenceDetailsRowStatusCode;
  label: string;
}

type ExistingOccurrenceTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;
type NewPropertyTarget = Extract<MetadataDraftTarget, { kind: "NewProperty" }>;

type ExistingTargetability = ReturnType<
  typeof existingOccurrenceTargetFromOccurrence
>;

interface OccurrenceDetailsRowCommon {
  key: string;
  group: string;
  groupSource: OccurrenceDetailsGroupSource;
  label: string;
  currentValue: string;
  stagedValue: string | null;
  status: OccurrenceDetailsRowStatus;
  originQualifier: string | null;
  diagnosticTitle: string;
  searchText: string;
  removalTarget: MetadataDraftTarget | null;
  draftTargets: MetadataDraftTarget[];
}

export interface ExistingOccurrenceRow extends OccurrenceDetailsRowCommon {
  kind: "ExistingOccurrenceRow";
  occurrence: MetadataOccurrence;
  targetability: ExistingTargetability;
  draft: MetadataTargetDraftEntry | null;
  staleDraft: MetadataTargetDraftEntry | null;
  duplicateOccurrenceId: boolean;
  effectiveDraftValue: MetadataValue | null;
}

export interface NewPropertyRow extends OccurrenceDetailsRowCommon {
  kind: "NewPropertyRow";
  target: NewPropertyTarget;
  edit: MetadataDraftEdit;
  tagInfo: TagInfo | null;
  intendedDestination: MetadataWriteTarget;
  destinationSafety: NewPropertyDestinationSafety;
}

export interface MissingOccurrenceDraftRow extends OccurrenceDetailsRowCommon {
  kind: "MissingOccurrenceDraftRow";
  target: ExistingOccurrenceTarget;
  edit: MetadataDraftEdit;
  storedDestination: MetadataWriteTarget;
}

export type OccurrenceDetailsRow =
  ExistingOccurrenceRow | NewPropertyRow | MissingOccurrenceDraftRow;

export interface OccurrenceDetailsGroup {
  name: string;
  fallback: boolean;
  rows: OccurrenceDetailsRow[];
}

export interface OccurrenceDetailsPresentation {
  groups: OccurrenceDetailsGroup[];
}

export interface BuildOccurrenceDetailsPresentationInput {
  occurrences: readonly MetadataOccurrence[];
  targetDrafts?: TargetDraftCollection;
  tagInfos?: Readonly<Record<string, TagInfo | null | undefined>>;
}

function existingGroup(occurrence: MetadataOccurrence): {
  name: string;
  source: OccurrenceDetailsGroupSource;
  fallback: boolean;
} {
  if (occurrence.observed_selector?.group1) {
    return {
      name: occurrence.observed_selector.group1,
      source: "observed-selector",
      fallback: false,
    };
  }
  if (occurrence.tag_info?.group) {
    return {
      name: occurrence.tag_info.group,
      source: "tag-info",
      fallback: false,
    };
  }
  return {
    name: `Unknown (${occurrence.schema_id.table})`,
    source: "schema-table-fallback",
    fallback: true,
  };
}

function existingLabel(occurrence: MetadataOccurrence): string {
  return (
    occurrence.tag_info?.name ??
    occurrence.observed_selector?.tag_name ??
    occurrence.schema_id.tag_id ??
    formatSchemaDefinitionIdForDiagnostics(occurrence.schema_id)
  );
}

function draftDisplay(
  schemaId: SchemaDefinitionId,
  draft: MetadataTargetDraftEntry | null,
  effectiveDraftValue: MetadataValue | null,
  displayTagInfo: TagInfo | null,
): string | null {
  if (effectiveDraftValue === null) return null;
  if (draft?.edit.intent === "Set" && draft.edit.display) {
    return draft.edit.display;
  }
  return displayTagInfo
    ? metadataValueToDisplayStringForTag(
        schemaId,
        effectiveDraftValue,
        displayTagInfo,
      )
    : metadataValueToDisplayString(effectiveDraftValue);
}

function currentDisplay(
  occurrence: MetadataOccurrence,
  displayTagInfo: TagInfo | null,
): string {
  return displayTagInfo
    ? metadataValueToDisplayStringForTag(
        occurrence.schema_id,
        occurrence.value,
        displayTagInfo,
      )
    : metadataValueToDisplayString(occurrence.value);
}

function targetGroup(target: MetadataDraftTarget): string {
  return target.write_target.group1;
}

function targetLabel(
  target: MetadataDraftTarget,
  tagInfo: TagInfo | null,
): string {
  return (
    tagInfo?.name ??
    target.write_target.tag_name ??
    target.schema_id.tag_id ??
    formatSchemaDefinitionIdForDiagnostics(target.schema_id)
  );
}

function status(
  code: OccurrenceDetailsRowStatusCode,
): OccurrenceDetailsRowStatus {
  const labels: Record<OccurrenceDetailsRowStatusCode, string> = {
    current: "",
    edited: "Edited",
    "read-only": "Read-only",
    "stale-target": "Stale target",
    "duplicate-occurrence-id": "Duplicate occurrence ID",
    new: "New",
    "destination-occupied": "Destination occupied",
    "pending-target-conflict": "Destination used by pending edit",
    "destination-unknown": "Destination cannot be verified",
    "preview-unsupported": "Staged preview unavailable",
    "missing-occurrence": "Missing occurrence",
    "conflicting-targets": "Conflicting targets",
  };
  return { code, label: labels[code] };
}

function occurrenceSearchParts(input: {
  occurrence: MetadataOccurrence;
  label: string;
  group: string;
  currentValue: string;
  stagedValue: string | null;
  rowStatus: OccurrenceDetailsRowStatus;
  targetability: ExistingTargetability;
  draft: MetadataTargetDraftEntry | null;
  staleDraft: MetadataTargetDraftEntry | null;
}): string[] {
  const { occurrence } = input;
  return [
    input.label,
    input.group,
    input.currentValue,
    input.stagedValue ?? "",
    input.rowStatus.label,
    formatSchemaDefinitionIdForDiagnostics(occurrence.schema_id),
    occurrence.schema_id.table,
    occurrence.schema_id.tag_id,
    occurrence.schema_id.index == null
      ? ""
      : String(occurrence.schema_id.index),
    formatMetadataOccurrenceIdForDiagnostics(occurrence.id),
    occurrence.id.document ?? "",
    occurrence.id.path,
    occurrence.id.runtime_tag_id,
    occurrence.id.tag_id_scope.table,
    occurrence.id.tag_id_scope.tag_id,
    occurrence.id.tag_id_scope.index == null
      ? ""
      : String(occurrence.id.tag_id_scope.index),
    String(occurrence.id.copy),
    occurrence.observed_selector
      ? metadataWriteSelector(occurrence.observed_selector)
      : "Observed selector unavailable",
    occurrence.write_target
      ? metadataWriteSelector(occurrence.write_target)
      : "Write target unavailable",
    input.targetability.kind === "read-only"
      ? input.targetability.reason
      : metadataDraftTargetToken(input.targetability.target),
    input.draft ? JSON.stringify(input.draft) : "",
    input.staleDraft ? JSON.stringify(input.staleDraft) : "",
  ];
}

function targetSearchParts(input: {
  target: MetadataDraftTarget;
  edit: MetadataDraftEdit;
  label: string;
  group: string;
  stagedValue: string | null;
  rowStatus: OccurrenceDetailsRowStatus;
  tagInfo: TagInfo | null;
}): string[] {
  return [
    input.label,
    input.group,
    input.stagedValue ?? "",
    input.rowStatus.label,
    formatSchemaDefinitionIdForDiagnostics(input.target.schema_id),
    input.target.schema_id.table,
    input.target.schema_id.tag_id,
    input.target.schema_id.index == null
      ? ""
      : String(input.target.schema_id.index),
    input.tagInfo?.group ?? "",
    input.tagInfo?.name ?? "",
    metadataWriteSelector(input.target.write_target),
    input.target.write_target.group1,
    input.target.write_target.group7,
    input.target.write_target.tag_name,
    metadataDraftTargetToken(input.target),
    JSON.stringify(input.edit),
    input.target.kind === "ExistingOccurrence"
      ? formatMetadataOccurrenceIdForDiagnostics(input.target.occurrence_id)
      : "",
  ];
}

function diagnosticTitle(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

function rowSortToken(row: OccurrenceDetailsRow): string {
  switch (row.kind) {
    case "ExistingOccurrenceRow":
      return metadataOccurrenceIdToken(row.occurrence.id);
    case "NewPropertyRow":
      return metadataDraftTargetToken(row.target);
    case "MissingOccurrenceDraftRow":
      return metadataDraftTargetToken(row.target);
  }
}

function rowKindRank(row: OccurrenceDetailsRow): number {
  switch (row.kind) {
    case "ExistingOccurrenceRow":
      return 0;
    case "NewPropertyRow":
      return 1;
    case "MissingOccurrenceDraftRow":
      return 2;
  }
}

function withOriginQualifiers(
  rows: OccurrenceDetailsRow[],
): OccurrenceDetailsRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
  }

  return rows.map((row) => {
    const duplicatedLabel = (counts.get(row.label) ?? 0) > 1;
    if (row.kind === "ExistingOccurrenceRow") {
      const unusual =
        row.occurrence.id.copy !== 0 || row.occurrence.id.document !== null;
      if (!duplicatedLabel && !unusual) return row;
      const parts = [
        row.occurrence.id.path,
        row.occurrence.id.copy === 0 ? null : `Copy${row.occurrence.id.copy}`,
        row.occurrence.id.document,
      ].filter((part): part is string => part !== null && part.length > 0);
      return { ...row, originQualifier: parts.join(" · ") };
    }
    if (!duplicatedLabel) return row;
    return {
      ...row,
      originQualifier: formatSchemaDefinitionIdForDiagnostics(
        row.target.schema_id,
      ),
    };
  });
}

export function buildOccurrenceDetailsPresentation(
  input: BuildOccurrenceDetailsPresentationInput,
): OccurrenceDetailsPresentation {
  const occurrences = input.occurrences.map((value) => structuredClone(value));
  const draftEntries = Object.values(input.targetDrafts ?? {}).map((entry) =>
    structuredClone(entry),
  );
  const existingDraftEntries = draftEntries.filter(
    (
      entry,
    ): entry is MetadataTargetDraftEntry & {
      target: ExistingOccurrenceTarget;
    } => entry.target.kind === "ExistingOccurrence",
  );
  const newDraftEntries = draftEntries.filter(
    (
      entry,
    ): entry is MetadataTargetDraftEntry & { target: NewPropertyTarget } =>
      entry.target.kind === "NewProperty",
  );

  const occurrenceCounts = new Map<string, number>();
  for (const occurrence of occurrences) {
    const token = metadataOccurrenceIdToken(occurrence.id);
    occurrenceCounts.set(token, (occurrenceCounts.get(token) ?? 0) + 1);
  }
  const draftsByOccurrence = new Map<
    string,
    Array<MetadataTargetDraftEntry & { target: ExistingOccurrenceTarget }>
  >();
  for (const entry of existingDraftEntries) {
    const token = metadataOccurrenceIdToken(entry.target.occurrence_id);
    const entries = draftsByOccurrence.get(token) ?? [];
    entries.push(entry);
    draftsByOccurrence.set(token, entries);
  }

  const consumedExistingDrafts = new Set<MetadataTargetDraftEntry>();
  const rows: Array<{ row: OccurrenceDetailsRow; fallback: boolean }> = [];

  occurrences.forEach((occurrence, index) => {
    const occurrenceToken = metadataOccurrenceIdToken(occurrence.id);
    const duplicateOccurrenceId =
      (occurrenceCounts.get(occurrenceToken) ?? 0) > 1;
    const matchingDrafts = draftsByOccurrence.get(occurrenceToken) ?? [];
    const targetability = existingOccurrenceTargetFromOccurrence(occurrence);
    let draft: MetadataTargetDraftEntry | null = null;
    let staleDraft: MetadataTargetDraftEntry | null = null;

    if (!duplicateOccurrenceId && matchingDrafts.length === 1) {
      const candidate = matchingDrafts[0];
      consumedExistingDrafts.add(candidate);
      if (
        targetability.kind === "targetable" &&
        metadataDraftTargetEquals(targetability.target, candidate.target)
      ) {
        draft = candidate;
      } else {
        staleDraft = candidate;
      }
    }

    const group = existingGroup(occurrence);
    const label = existingLabel(occurrence);
    const displayTagInfo =
      input.tagInfos?.[schemaDefinitionIdToken(occurrence.schema_id)] ??
      occurrence.tag_info;
    const currentValue = currentDisplay(occurrence, displayTagInfo);
    const effectiveDraft =
      draft === null
        ? null
        : applyMetadataDraftEditExactly(
            occurrence.value,
            draft.edit,
            displayTagInfo?.kind,
          );
    const effectiveDraftValue =
      effectiveDraft?.applied === true ? (effectiveDraft.value ?? null) : null;
    const stagedValue = draftDisplay(
      occurrence.schema_id,
      draft,
      effectiveDraftValue,
      displayTagInfo,
    );
    const rowStatus = duplicateOccurrenceId
      ? status("duplicate-occurrence-id")
      : staleDraft
        ? status("stale-target")
        : effectiveDraft?.applied === false
          ? status("preview-unsupported")
          : draft
            ? status("edited")
            : targetability.kind === "read-only"
              ? status("read-only")
              : status("current");
    const searchParts = occurrenceSearchParts({
      occurrence,
      label,
      group: group.name,
      currentValue,
      stagedValue,
      rowStatus,
      targetability,
      draft,
      staleDraft,
    });
    if (effectiveDraft?.applied === false) {
      searchParts.push(effectiveDraft.reason);
    }

    rows.push({
      fallback: group.fallback,
      row: {
        kind: "ExistingOccurrenceRow",
        key: `existing:${occurrenceToken}:${index}`,
        group: group.name,
        groupSource: group.source,
        label,
        currentValue,
        stagedValue,
        status: rowStatus,
        originQualifier: null,
        diagnosticTitle: diagnosticTitle(searchParts),
        searchText: searchParts.join("\n"),
        removalTarget:
          !duplicateOccurrenceId && targetability.kind === "targetable"
            ? structuredClone(targetability.target)
            : null,
        draftTargets: draft
          ? [structuredClone(draft.target)]
          : staleDraft
            ? [structuredClone(staleDraft.target)]
            : [],
        occurrence,
        targetability,
        draft,
        staleDraft,
        duplicateOccurrenceId,
        effectiveDraftValue,
      },
    });
  });

  for (const entry of newDraftEntries) {
    const tagInfo =
      input.tagInfos?.[schemaDefinitionIdToken(entry.target.schema_id)] ?? null;
    const group = targetGroup(entry.target);
    const label = targetLabel(entry.target, tagInfo);
    const stagedValue = displayStringOfMetadataDraft(entry.edit) ?? null;
    const destinationSafety = classifyNewPropertyDestination({
      schemaId: entry.target.schema_id,
      writeTarget: entry.target.write_target,
      occurrences,
      pendingTargets: draftEntries.map((candidate) => candidate.target),
      ignoredPendingTarget: entry.target,
    });
    const rowStatus =
      destinationSafety.kind === "occupied"
        ? status("destination-occupied")
        : destinationSafety.kind === "pending-collision"
          ? status("pending-target-conflict")
          : destinationSafety.kind === "unknown-same-schema"
            ? status("destination-unknown")
            : status("new");
    const searchParts = targetSearchParts({
      target: entry.target,
      edit: entry.edit,
      label,
      group,
      stagedValue,
      rowStatus,
      tagInfo,
    });
    if (destinationSafety.kind === "pending-collision") {
      searchParts.push(
        "Destination used by pending edit",
        JSON.stringify(destinationSafety.target),
        metadataDraftTargetToken(destinationSafety.target),
      );
    }
    rows.push({
      fallback: false,
      row: {
        kind: "NewPropertyRow",
        key: `new:${metadataDraftTargetToken(entry.target)}`,
        group,
        groupSource: "write-target",
        label,
        currentValue: "",
        stagedValue,
        status: rowStatus,
        originQualifier: null,
        diagnosticTitle: diagnosticTitle(searchParts),
        searchText: searchParts.join("\n"),
        removalTarget: structuredClone(entry.target),
        draftTargets: [structuredClone(entry.target)],
        target: entry.target,
        edit: entry.edit,
        tagInfo: tagInfo ? structuredClone(tagInfo) : null,
        intendedDestination: structuredClone(entry.target.write_target),
        destinationSafety: structuredClone(destinationSafety),
      },
    });
  }

  for (const entry of existingDraftEntries) {
    if (consumedExistingDrafts.has(entry)) continue;
    const occurrenceToken = metadataOccurrenceIdToken(
      entry.target.occurrence_id,
    );
    const occurrenceCount = occurrenceCounts.get(occurrenceToken) ?? 0;
    const rowStatus =
      occurrenceCount === 0
        ? status("missing-occurrence")
        : occurrenceCount > 1
          ? status("duplicate-occurrence-id")
          : status("conflicting-targets");
    const group = targetGroup(entry.target);
    const tagInfo =
      input.tagInfos?.[schemaDefinitionIdToken(entry.target.schema_id)] ?? null;
    const label = targetLabel(entry.target, tagInfo);
    const stagedValue = displayStringOfMetadataDraft(entry.edit) ?? null;
    const searchParts = targetSearchParts({
      target: entry.target,
      edit: entry.edit,
      label,
      group,
      stagedValue,
      rowStatus,
      tagInfo,
    });
    rows.push({
      fallback: false,
      row: {
        kind: "MissingOccurrenceDraftRow",
        key: `missing:${metadataDraftTargetToken(entry.target)}`,
        group,
        groupSource: "write-target",
        label,
        currentValue: "",
        stagedValue,
        status: rowStatus,
        originQualifier: null,
        diagnosticTitle: diagnosticTitle(searchParts),
        searchText: searchParts.join("\n"),
        removalTarget: null,
        draftTargets: [structuredClone(entry.target)],
        target: entry.target,
        edit: entry.edit,
        storedDestination: structuredClone(entry.target.write_target),
      },
    });
  }

  const grouped = new Map<
    string,
    { fallbackFlags: boolean[]; rows: OccurrenceDetailsRow[] }
  >();
  for (const item of rows) {
    const group = grouped.get(item.row.group) ?? {
      fallbackFlags: [],
      rows: [],
    };
    group.fallbackFlags.push(item.fallback);
    group.rows.push(item.row);
    grouped.set(item.row.group, group);
  }

  const groups = Array.from(grouped.entries())
    .map(([name, value]) => {
      const sorted = value.rows.slice().sort((left, right) => {
        const label = left.label.localeCompare(right.label);
        if (label !== 0) return label;
        const kind = rowKindRank(left) - rowKindRank(right);
        if (kind !== 0) return kind;
        return rowSortToken(left).localeCompare(rowSortToken(right));
      });
      return {
        name,
        fallback: value.fallbackFlags.every(Boolean),
        rows: withOriginQualifiers(sorted),
      };
    })
    .sort((left, right) => {
      if (left.fallback !== right.fallback) return left.fallback ? 1 : -1;
      return left.name.localeCompare(right.name);
    });

  return { groups };
}
