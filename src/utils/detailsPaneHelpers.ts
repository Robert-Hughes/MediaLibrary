import type {
  ImageMetadataEntry,
  MetadataOccurrence,
  PhotoInfo,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  metadataEntryToDisplayString as metadataValueToDisplayString,
  metadataValueToDisplayStringForTag,
} from "../draft";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";
import type { TagInfoCacheEntry } from "../hooks/useTagInfo";
import type { MetadataCollection } from "./metadataCollection";
import { metadataGet } from "./metadataCollection";
import {
  compareMetadataOccurrenceIds,
  formatMetadataOccurrenceIdForDiagnostics,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
import type { SchemaOccurrenceResolutionIndex } from "./metadataOccurrences";
import { resolutionForSchema } from "./metadataOccurrences";

export const formatMetadataValue = metadataValueToDisplayString;

/**
 * Overlay unique authoritative occurrence values onto the read-only,
 * schema-oriented value collection derived from occurrences for Details Pane
 * editors. Missing and ambiguous schemas retain only the conservative
 * projection. This is neither authoritative occurrence state nor a
 * target-selection mechanism.
 */
export function overlayUniqueOccurrenceValues(
  schemaProjection: MetadataCollection,
  resolutionIndex: SchemaOccurrenceResolutionIndex,
): MetadataCollection {
  const authoritative = { ...schemaProjection };

  for (const resolution of resolutionIndex.values()) {
    if (resolution.kind !== "unique") continue;

    const id = resolution.occurrence.schema_id;
    authoritative[schemaDefinitionIdToken(id)] = {
      ...resolution.occurrence.value,
      id,
    };
  }

  return authoritative;
}

/** Format an OS timestamp (seconds since epoch, from Rust) into a readable string. */
export function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

/**
 * OS-level metadata entries (always available from the directory walk).
 */
export function getOsEntries(
  photo: PhotoInfo,
): Array<[string, string, string]> {
  return [
    ["Filename", photo.filename, "filename"],
    ["Relative Path", photo.relative_path, "relative_path"],
    ["Date Modified", formatTimestamp(photo.date_modified), "date_modified"],
    ["Date Created", formatTimestamp(photo.date_created), "date_created"],
  ];
}

/** Group key prefix (e.g. "IFD0" from "IFD0:Make"). Keys without a colon go in "Other". */
export function extractPrefix(key: string): string {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : "Other";
}

export interface MetadataEntry {
  id: ImageMetadataEntry["id"];
  identityToken: string;
  label: string;
  friendlyName: string;
  value: string;
}

export interface MetadataGroup {
  prefix: string;
  entries: MetadataEntry[];
}

export interface MetadataOccurrenceDisplayEntry {
  occurrence: MetadataOccurrence;
  identityToken: string;
  schemaId: SchemaDefinitionId;
  label: string;
  value: string;
  origin: string;
  originTitle: string;
  searchText: string;
}

/**
 * Build exact rows for authoritative occurrences that either have no
 * ordinary schema-oriented row, belong to a multiply-resolved schema, or have no known
 * schema. Unknown-schema rows remain visible but cannot become write targets.
 */
export function supplementalResolvedMetadataOccurrences(
  occurrences: readonly MetadataOccurrence[],
  schemaProjection: MetadataCollection,
  resolutionIndex: SchemaOccurrenceResolutionIndex,
): MetadataOccurrenceDisplayEntry[] {
  return occurrences
    .filter(
      (occurrence) =>
        metadataGet(schemaProjection, occurrence.schema_id) === undefined ||
        resolutionForSchema(resolutionIndex, occurrence.schema_id).kind ===
          "multiple" ||
        occurrence.tag_info === null,
    )
    .sort((a, b) => compareMetadataOccurrenceIds(a.id, b.id))
    .map((occurrence) => {
      const tagInfo = occurrence.tag_info;
      const runtimeGroup = occurrence.write_target?.group1;
      const displayGroup = runtimeGroup ?? tagInfo?.group ?? "Unknown schema";
      const copy =
        occurrence.id.copy === 0 ? "primary" : `Copy${occurrence.id.copy}`;
      const document = occurrence.id.document
        ? ` · ${occurrence.id.document}`
        : "";
      const origin = `${displayGroup} · ${occurrence.id.path} · ${copy}${document}`;
      const selector = occurrence.write_target
        ? `${occurrence.write_target.group1}:${occurrence.write_target.tag_name}`
        : "unavailable";
      const locationExplanation = runtimeGroup
        ? `Runtime group: ${runtimeGroup}`
        : tagInfo
          ? `Schema-group display fallback: ${tagInfo.group} (not a claimed runtime location)`
          : "The exact schema is unresolved in the local registry";
      const value = tagInfo
        ? metadataValueToDisplayStringForTag(
            occurrence.schema_id,
            occurrence.value,
            tagInfo,
          )
        : metadataValueToDisplayString(occurrence.value);

      return {
        occurrence,
        identityToken: metadataOccurrenceIdToken(occurrence.id),
        schemaId: occurrence.schema_id,
        label:
          tagInfo?.name ??
          formatSchemaDefinitionIdForDiagnostics(occurrence.schema_id),
        value,
        origin,
        originTitle: [
          formatMetadataOccurrenceIdForDiagnostics(occurrence.id),
          `Schema: ${formatSchemaDefinitionIdForDiagnostics(
            occurrence.schema_id,
          )}`,
          locationExplanation,
          `Exact write selector: ${selector}`,
        ].join("\n"),
        searchText: [
          tagInfo?.name,
          formatSchemaDefinitionIdForDiagnostics(occurrence.schema_id),
          occurrence.schema_id.table,
          occurrence.schema_id.tag_id,
          occurrence.schema_id.index == null
            ? undefined
            : String(occurrence.schema_id.index),
          value,
          tagInfo ? `${tagInfo.group}:${tagInfo.name}` : undefined,
          occurrence.write_target?.group1,
          selector,
          occurrence.id.document,
          occurrence.id.path,
          occurrence.id.runtime_tag_id,
          occurrence.id.tag_id_scope.table,
          occurrence.id.tag_id_scope.tag_id,
          occurrence.id.tag_id_scope.index == null
            ? undefined
            : String(occurrence.id.tag_id_scope.index),
          String(occurrence.id.copy),
          copy,
        ]
          .filter((part): part is string => part != null)
          .join("\n"),
      };
    });
}

/**
 * Group image metadata entries by their key prefix, preserving a stable order.
 * Returns groups sorted alphabetically by prefix, with "Other" last.
 */
export function groupImageMetadata(
  metadata: Record<string, ImageMetadataEntry>,
  tagInfos: Record<string, TagInfoCacheEntry> = {},
): MetadataGroup[] {
  const grouped = new Map<string, MetadataEntry[]>();

  const entries = Object.values(metadata).sort((a, b) =>
    schemaDefinitionIdToken(a.id).localeCompare(schemaDefinitionIdToken(b.id)),
  );

  for (const value of entries) {
    const token = schemaDefinitionIdToken(value.id);
    const info = tagInfos[token];
    const tagInfo: TagInfo | null = info && info !== "loading" ? info : null;
    const prefix = tagInfo?.group ?? value.id.table;
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    const label = tagInfo?.name ?? value.id.tag_id;
    grouped.get(prefix)!.push({
      id: value.id,
      identityToken: token,
      label,
      friendlyName: tagInfo
        ? `${tagInfo.group}:${tagInfo.name}`
        : formatSchemaDefinitionIdForDiagnostics(value.id),
      value: formatMetadataValue(value),
    });
  }

  const groups: MetadataGroup[] = [];
  const sortedPrefixes = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  for (const prefix of sortedPrefixes) {
    groups.push({ prefix, entries: grouped.get(prefix)! });
  }

  return groups;
}
