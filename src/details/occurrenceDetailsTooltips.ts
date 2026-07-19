import type { OccurrenceDetailsRow } from "./occurrenceDetailsPresentation";
import type { DatatypeInfo } from "../utils/datatype";
import {
  datatypesMatch,
  metadataValueDatatype,
  schemaDatatype,
} from "../utils/datatype";
import { family7GroupFromRuntimeTagId } from "../utils/metadataWriteTarget";

export interface OccurrenceRowDatatypeInfo {
  schemaInfo: DatatypeInfo | null;
  valueInfo: DatatypeInfo | null;
  draftInfo: DatatypeInfo | null;
}

type TooltipLine = readonly [label: string, value: string | null | undefined];

export function formatDetailsTooltip(lines: readonly TooltipLine[]): string {
  return lines
    .filter((line): line is readonly [string, string] => {
      const value = line[1];
      return value !== null && value !== undefined;
    })
    .map(([label, value]) => `${label}: ${value.replace(/\r\n?|\n/g, " ⏎ ")}`)
    .join("\n");
}

export function rowDatatypeInfo(
  row: OccurrenceDetailsRow,
): OccurrenceRowDatatypeInfo {
  const schemaInfo = schemaDatatype(row.tagInfo?.kind);
  switch (row.kind) {
    case "ExistingOccurrenceRow": {
      const valueInfo = metadataValueDatatype(row.occurrence.value);
      const draftInfo =
        row.effectiveDraftApplied === true && row.effectiveDraftValue !== null
          ? metadataValueDatatype(row.effectiveDraftValue)
          : null;
      return { schemaInfo, valueInfo, draftInfo };
    }
    case "NewPropertyRow":
    case "MissingOccurrenceDraftRow": {
      const draftInfo =
        row.edit.intent !== "Delete" && row.edit.value != null
          ? metadataValueDatatype(row.edit.value)
          : null;
      return { schemaInfo, valueInfo: null, draftInfo };
    }
  }
}

function datatypeLabel(info: DatatypeInfo | null): string {
  return info ? `${info.label} (${info.code})` : "unknown";
}

function booleanLabel(value: boolean | null): string {
  return value === null ? "unknown" : value ? "true" : "false";
}

function schemaLines(
  row: OccurrenceDetailsRow,
  schemaInfo: DatatypeInfo | null,
): TooltipLine[] {
  const schemaId =
    row.kind === "ExistingOccurrenceRow"
      ? row.occurrence.schema_id
      : row.target.schema_id;
  return [
    ["Schema table", schemaId.table],
    ["Schema tag ID", schemaId.tag_id],
    ["Schema index", schemaId.index == null ? null : String(schemaId.index)],
    ["Schema datatype", datatypeLabel(schemaInfo)],
    ["Schema writable", booleanLabel(row.tagInfo?.writable ?? null)],
  ];
}

function runtimeScope(
  row: Extract<OccurrenceDetailsRow, { kind: "ExistingOccurrenceRow" }>,
): string | null {
  const scope = row.occurrence.id.tag_id_scope;
  const schema = row.occurrence.schema_id;
  if (
    scope.table === schema.table &&
    scope.tag_id === schema.tag_id &&
    (scope.index ?? null) === (schema.index ?? null)
  ) {
    return null;
  }
  return `${scope.table} / ${scope.tag_id}${
    scope.index == null ? "" : ` / index ${scope.index}`
  }`;
}

function existingReason(
  row: Extract<OccurrenceDetailsRow, { kind: "ExistingOccurrenceRow" }>,
  editable: boolean,
  forceReadOnlyReason?: string,
): string | null {
  if (forceReadOnlyReason) return forceReadOnlyReason;
  if (row.duplicateOccurrenceId) {
    return "Multiple rows share this occurrence identity, so the exact edit target is ambiguous.";
  }
  if (row.staleDraft) {
    return "The stored draft target no longer matches this occurrence's current identity.";
  }
  if (!editable && row.targetability.kind === "read-only") {
    return row.targetability.reason;
  }
  return null;
}

function destinationReason(
  row: Extract<OccurrenceDetailsRow, { kind: "NewPropertyRow" }>,
  forceReadOnlyReason?: string,
): string | null {
  if (forceReadOnlyReason) return forceReadOnlyReason;
  switch (row.destinationSafety.kind) {
    case "available":
      return null;
    case "occupied":
      return "The destination is already occupied by an existing occurrence.";
    case "pending-collision":
      return "The destination is used by another pending edit.";
    case "unknown-same-schema":
      return "The destination cannot be verified safely.";
  }
}

export function buildOccurrenceNameTooltip(input: {
  row: OccurrenceDetailsRow;
  datatypeInfo: OccurrenceRowDatatypeInfo;
  editable: boolean;
  forceReadOnlyReason?: string;
}): string {
  const { row, datatypeInfo, editable, forceReadOnlyReason } = input;
  if (row.kind === "ExistingOccurrenceRow") {
    const observed = row.occurrence.observed_selector;
    const id = row.occurrence.id;
    return formatDetailsTooltip([
      ["Property", row.label],
      ["Description", row.tagInfo?.description?.trim() || null],
      ["Family 1", observed?.group1 ?? "unavailable"],
      ["Family 3", id.document ?? "Main"],
      ["Family 4", `Copy${id.copy}`],
      ["Family 5", id.path],
      [
        "Family 7",
        observed?.group7 ?? family7GroupFromRuntimeTagId(id.runtime_tag_id),
      ],
      [
        "Runtime tag name",
        observed?.tag_name && observed.tag_name !== row.label
          ? observed.tag_name
          : null,
      ],
      ["Runtime ID scope", runtimeScope(row)],
      ...schemaLines(row, datatypeInfo.schemaInfo),
      ["Editable", booleanLabel(editable)],
      ["Status", row.status.label || null],
      ["Reason", existingReason(row, editable, forceReadOnlyReason)],
    ]);
  }

  if (row.kind === "NewPropertyRow") {
    const destination = row.intendedDestination;
    return formatDetailsTooltip([
      ["Property", row.label],
      ["Description", row.tagInfo?.description?.trim() || null],
      ["Field state", "New property"],
      ["Destination family 1", destination.group1],
      ["Destination family 7", destination.group7],
      [
        "Destination tag name",
        destination.tag_name === row.label ? null : destination.tag_name,
      ],
      ...schemaLines(row, datatypeInfo.schemaInfo),
      ["Editable", booleanLabel(editable)],
      ["Status", row.status.label || null],
      ["Reason", destinationReason(row, forceReadOnlyReason)],
    ]);
  }

  const id = row.target.occurrence_id;
  const destination = row.storedDestination;
  const missingReason = forceReadOnlyReason
    ? forceReadOnlyReason
    : row.status.code === "duplicate-occurrence-id"
      ? "Multiple occurrences share the stored occurrence identity."
      : row.status.code === "conflicting-targets"
        ? "The stored target conflicts with the current occurrence."
        : "The stored occurrence is no longer present.";
  return formatDetailsTooltip([
    ["Property", row.label],
    ["Field state", "Missing occurrence"],
    ["Family 3", id.document ?? "Main"],
    ["Family 4", `Copy${id.copy}`],
    ["Family 5", id.path],
    ["Family 7", family7GroupFromRuntimeTagId(id.runtime_tag_id)],
    ["Stored destination family 1", destination.group1],
    ["Stored destination family 7", destination.group7],
    [
      "Stored destination tag name",
      destination.tag_name === row.label ? null : destination.tag_name,
    ],
    ...schemaLines(row, datatypeInfo.schemaInfo),
    ["Editable", "false"],
    ["Status", row.status.label || null],
    ["Reason", missingReason],
  ]);
}

function compatibility(
  valueInfo: DatatypeInfo | null,
  schemaInfo: DatatypeInfo | null,
): string | null {
  if (!valueInfo || !schemaInfo) return null;
  return booleanLabel(datatypesMatch(valueInfo.code, schemaInfo.code));
}

export function buildOccurrenceValueTooltip(input: {
  row: OccurrenceDetailsRow;
  datatypeInfo: OccurrenceRowDatatypeInfo;
}): string {
  const { row, datatypeInfo } = input;
  const lines: TooltipLine[] = [];
  if (row.kind === "ExistingOccurrenceRow") {
    lines.push(
      ["Current value", row.currentValue],
      ["Current datatype", datatypeLabel(datatypeInfo.valueInfo)],
      [
        "Current matches schema",
        compatibility(datatypeInfo.valueInfo, datatypeInfo.schemaInfo),
      ],
    );
    if (!row.draft) {
      lines.push(["Draft action", "none"]);
      return formatDetailsTooltip(lines);
    }
    lines.push(["Draft action", row.draft.edit.intent]);
    if (row.draft.edit.intent === "Delete") {
      lines.push(["Staged value", "deleted"]);
    } else if (row.effectiveDraftApplied === false) {
      lines.push(
        ["Draft preview", "unavailable"],
        ["Reason", row.effectiveDraftReason ?? "unavailable"],
      );
    } else {
      lines.push(
        ["Staged value", row.stagedValue ?? "unavailable"],
        ["Staged datatype", datatypeLabel(datatypeInfo.draftInfo)],
        [
          "Staged matches schema",
          compatibility(datatypeInfo.draftInfo, datatypeInfo.schemaInfo),
        ],
      );
    }
    return formatDetailsTooltip(lines);
  }

  lines.push([
    "Current value",
    row.kind === "NewPropertyRow" ? "not present" : "occurrence missing",
  ]);
  lines.push(["Draft action", row.edit.intent]);
  if (row.edit.intent === "Delete") {
    lines.push(["Staged value", "deleted"]);
  } else if (row.stagedValue === null) {
    lines.push(
      ["Draft preview", "unavailable"],
      ["Reason", "The staged value could not be previewed."],
    );
  } else {
    lines.push(
      ["Staged value", row.stagedValue],
      ["Staged datatype", datatypeLabel(datatypeInfo.draftInfo)],
      [
        "Staged matches schema",
        compatibility(datatypeInfo.draftInfo, datatypeInfo.schemaInfo),
      ],
    );
  }
  return formatDetailsTooltip(lines);
}
