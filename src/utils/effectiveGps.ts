import { gpsMemberGroup } from "../metadata/tag_overrides";
import { KNOWN_METADATA_IDS } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import {
  resolveTargetDraftByExactSchema,
  targetDraftSchemas,
} from "../targetDraftView";
import type {
  GeocodeRequestItem,
  ImageMetadataEntry,
  ImageMetadataOccurrencesState,
  MetadataDraftCollection,
} from "../types";
import { buildEffectiveMetadata } from "./buildNormaliseItems";
import { overlayUniqueOccurrenceValues } from "./detailsPaneHelpers";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./metadataDraftTarget";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolveExactMetadataOccurrence,
  resolutionForSchema,
} from "./metadataOccurrences";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import { resolveGps } from "./resolveGps";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";

export interface EffectiveGpsInput {
  metadata: MetadataCollection | undefined;
  occurrences: ImageMetadataOccurrencesState | undefined;
  legacyDrafts: MetadataDraftCollection | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}

const COMPOSITE_COORDINATE_IDS = [
  KNOWN_METADATA_IDS.compositeGpsLatitude,
  KNOWN_METADATA_IDS.compositeGpsLongitude,
] as const;

function hasExactLegacyOwner(
  drafts: MetadataDraftCollection | undefined,
  schemaId: Parameters<typeof gpsMemberGroup>[0],
): boolean {
  return Object.values(drafts ?? {}).some((entry) =>
    schemaDefinitionIdEquals(entry.id, schemaId),
  );
}

function isCoordinateMember(schemaId: Parameters<typeof gpsMemberGroup>[0]) {
  const group = gpsMemberGroup(schemaId);
  return (
    group !== null &&
    [
      group.latitudeId,
      group.latitudeRefId,
      group.longitudeId,
      group.longitudeRefId,
    ].some((id) => schemaDefinitionIdEquals(id, schemaId))
  );
}

/**
 * Resolve the coordinates currently presented for one file.
 *
 * Compatibility metadata is the required base. Unique authoritative
 * occurrences replace that projection, schema-v4 drafts retain the existing
 * `resolveGps` precedence, and only unambiguous, still-current schema-v5 GPS
 * targets are overlaid. Inputs are never mutated.
 */
export function resolveEffectiveGpsForFile({
  metadata,
  occurrences,
  legacyDrafts,
  targetDrafts,
}: EffectiveGpsInput): { lat: number | null; lon: number | null } {
  if (metadata === undefined) return { lat: null, lon: null };

  const loadedOccurrences = Array.isArray(occurrences)
    ? occurrences
    : undefined;
  const occurrenceIndex = loadedOccurrences
    ? buildSchemaOccurrenceResolutionIndex(loadedOccurrences)
    : new Map();
  const authoritativeBase = loadedOccurrences
    ? overlayUniqueOccurrenceValues(metadata, occurrenceIndex)
    : { ...metadata };
  const effective = buildEffectiveMetadata(authoritativeBase, legacyDrafts);
  let suppressCompositeCoordinates = false;

  for (const schemaId of targetDraftSchemas(targetDrafts)) {
    if (gpsMemberGroup(schemaId) === null) continue;
    if (hasExactLegacyOwner(legacyDrafts, schemaId)) continue;

    const owner = resolveTargetDraftByExactSchema(targetDrafts, schemaId);
    if (owner.kind !== "unique") continue;
    const entry = owner.entry;
    let safelyPresented: boolean;

    if (entry.target.kind === "ExistingOccurrence") {
      if (loadedOccurrences === undefined) continue;
      if (resolutionForSchema(occurrenceIndex, schemaId).kind === "multiple") {
        continue;
      }
      const exact = resolveExactMetadataOccurrence(
        loadedOccurrences,
        entry.target.occurrence_id,
      );
      if (exact.kind !== "unique") continue;
      const currentTarget = existingOccurrenceTargetFromOccurrence(
        exact.occurrence,
      );
      safelyPresented =
        currentTarget.kind === "targetable" &&
        metadataDraftTargetEquals(currentTarget.target, entry.target);
    } else {
      if (loadedOccurrences === undefined) continue;
      safelyPresented =
        resolutionForSchema(occurrenceIndex, schemaId).kind === "missing" &&
        metadataGet(metadata, schemaId) === undefined;
    }

    if (!safelyPresented) continue;
    if (entry.edit.intent !== "Set" && entry.edit.intent !== "Delete") {
      continue;
    }

    const token = schemaDefinitionIdToken(schemaId);
    if (entry.edit.intent === "Set" && entry.edit.value !== null) {
      effective[token] = {
        ...entry.edit.value,
        id: schemaId,
      } as ImageMetadataEntry;
    } else if (entry.edit.intent === "Delete") {
      delete effective[token];
    }
    if (isCoordinateMember(schemaId)) suppressCompositeCoordinates = true;
  }

  if (suppressCompositeCoordinates) {
    for (const id of COMPOSITE_COORDINATE_IDS) {
      delete effective[schemaDefinitionIdToken(id)];
    }
  }

  return resolveGps(legacyDrafts, effective);
}

/** Build the unchanged reverse-geocode wire item from the shared GPS view. */
export function buildGeocodeRequestItemForFile(
  relPath: string,
  input: EffectiveGpsInput,
): GeocodeRequestItem {
  return { relPath, ...resolveEffectiveGpsForFile(input) };
}
