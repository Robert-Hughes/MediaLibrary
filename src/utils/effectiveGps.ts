import type { TargetDraftCollection } from "../targetDraftEdits";
import { GPS_IDS } from "../metadata/knownIds";
import type {
  GeocodeRequestItem,
  FileMetadataOccurrencesState,
} from "../types";
import { buildEffectiveMetadataForFile } from "./effectiveMetadata";
import { resolveGps } from "./resolveGps";

export interface EffectiveGpsInput {
  occurrences: FileMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}

const EFFECTIVE_GPS_IDS = [
  GPS_IDS.latitude,
  GPS_IDS.latitudeRef,
  GPS_IDS.longitude,
  GPS_IDS.longitudeRef,
] as const;

export function resolveEffectiveGpsForFile(input: EffectiveGpsInput): {
  lat: number | null;
  lon: number | null;
} {
  if (!Array.isArray(input.occurrences)) return { lat: null, lon: null };

  const effective = buildEffectiveMetadataForFile(input, {
    ids: EFFECTIVE_GPS_IDS,
  });
  return resolveGps(undefined, effective);
}

/** Build the unchanged reverse-geocode wire item from the shared GPS view. */
export function buildGeocodeRequestItemForFile(
  relPath: string,
  input: EffectiveGpsInput,
): GeocodeRequestItem {
  return { relPath, ...resolveEffectiveGpsForFile(input) };
}
