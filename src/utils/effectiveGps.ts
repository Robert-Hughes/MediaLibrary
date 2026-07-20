import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  GeocodeRequestItem,
  ImageMetadataOccurrencesState,
} from "../types";
import { buildEffectiveMetadataForFile } from "./effectiveMetadata";
import { resolveGps } from "./resolveGps";

export interface EffectiveGpsInput {
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}

export function resolveEffectiveGpsForFile(input: EffectiveGpsInput): {
  lat: number | null;
  lon: number | null;
} {
  if (!Array.isArray(input.occurrences)) return { lat: null, lon: null };

  const effective = buildEffectiveMetadataForFile(input);
  return resolveGps(undefined, effective);
}

/** Build the unchanged reverse-geocode wire item from the shared GPS view. */
export function buildGeocodeRequestItemForFile(
  relPath: string,
  input: EffectiveGpsInput,
): GeocodeRequestItem {
  return { relPath, ...resolveEffectiveGpsForFile(input) };
}
