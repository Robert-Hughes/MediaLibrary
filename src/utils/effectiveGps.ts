import { KNOWN_METADATA_IDS } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  GeocodeRequestItem,
  ImageMetadataEntry,
  ImageMetadataOccurrencesState,
  MetadataValue,
} from "../types";
import { metadataValueEqual } from "../types";
import { buildEffectiveMetadataForFile } from "./effectiveMetadata";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import { resolveGps } from "./resolveGps";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

export interface EffectiveGpsInput {
  metadata: MetadataCollection | undefined;
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}

const COMPOSITE_COORDINATE_IDS = [
  KNOWN_METADATA_IDS.compositeGpsLatitude,
  KNOWN_METADATA_IDS.compositeGpsLongitude,
] as const;

const RAW_COORDINATE_MEMBER_IDS = [
  KNOWN_METADATA_IDS.gpsLatitude,
  KNOWN_METADATA_IDS.gpsLatitudeRef,
  KNOWN_METADATA_IDS.gpsLongitude,
  KNOWN_METADATA_IDS.gpsLongitudeRef,
] as const;

function valueOnly(
  entry: ImageMetadataEntry | undefined,
): MetadataValue | undefined {
  if (entry === undefined) return undefined;
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

function rawCoordinatesChanged(
  before: MetadataCollection,
  after: MetadataCollection,
): boolean {
  return RAW_COORDINATE_MEMBER_IDS.some(
    (id) =>
      !metadataValueEqual(
        valueOnly(metadataGet(before, id)),
        valueOnly(metadataGet(after, id)),
      ),
  );
}

/**
 * Resolve the coordinates currently presented for one file. The shared
 * effective-metadata resolver owns target-overlay validation; GPS
 * retains only its coordinate/ref interpretation and stale Composite
 * suppression.
 */
export function resolveEffectiveGpsForFile(input: EffectiveGpsInput): {
  lat: number | null;
  lon: number | null;
} {
  if (input.metadata === undefined) return { lat: null, lon: null };

  const authoritative = buildEffectiveMetadataForFile({
    metadata: input.metadata,
    occurrences: input.occurrences,
    targetDrafts: undefined,
  });
  const effective = buildEffectiveMetadataForFile(input);

  if (rawCoordinatesChanged(authoritative, effective)) {
    for (const id of COMPOSITE_COORDINATE_IDS) {
      delete effective[schemaDefinitionIdToken(id)];
    }
  }

  return resolveGps(undefined, effective);
}

/** Build the unchanged reverse-geocode wire item from the shared GPS view. */
export function buildGeocodeRequestItemForFile(
  relPath: string,
  input: EffectiveGpsInput,
): GeocodeRequestItem {
  return { relPath, ...resolveEffectiveGpsForFile(input) };
}
