// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GPS_IDS } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataTargetDraftEntry,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { mockMetadata } from "./factories";
import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";

const BASE_RAW = {
  "GPS:GPSLatitude": 51,
  "GPS:GPSLatitudeRef": "N",
  "GPS:GPSLongitude": 1,
  "GPS:GPSLongitudeRef": "E",
};

function valueFor(metadataValue: unknown): MetadataValue {
  if (typeof metadataValue === "number") {
    return { kind: "Real", value: metadataValue };
  }
  return { kind: "Text", value: String(metadataValue) };
}

function occurrence(
  id: SchemaDefinitionId,
  value: MetadataValue,
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: `JPEG-APP1-GPS-${id.tag_id}`,
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: 0,
    },
    value,
    tag_info: {
      id,
      group: "GPS",
      name: id.tag_id,
      writable: true,
      kind: { kind: value.kind } as never,
      description: null,
    },
    observed_selector: {
      group1: "GPS",
      group7: "ID-Test",
      tag_name: id.tag_id,
    },
    write_target: { group1: "GPS", group7: "ID-Test", tag_name: id.tag_id },
    ...overrides,
    schema_id: overrides.schema_id ?? structuredClone(id),
  };
}

function baseOccurrences(): MetadataOccurrence[] {
  return [
    occurrence(GPS_IDS.latitude, valueFor(51)),
    occurrence(GPS_IDS.latitudeRef, valueFor("N")),
    occurrence(GPS_IDS.longitude, valueFor(1)),
    occurrence(GPS_IDS.longitudeRef, valueFor("E")),
  ];
}

function zeroOccurrences(
  latitudeRef: "N" | "S" = "N",
  longitudeRef: "E" | "W" = "E",
): MetadataOccurrence[] {
  return [
    occurrence(GPS_IDS.latitude, valueFor(0)),
    occurrence(GPS_IDS.latitudeRef, valueFor(latitudeRef)),
    occurrence(GPS_IDS.longitude, valueFor(0)),
    occurrence(GPS_IDS.longitudeRef, valueFor(longitudeRef)),
  ];
}

function existingEntry(
  current: MetadataOccurrence,
  edit: MetadataDraftEdit,
): MetadataTargetDraftEntry & {
  target: Extract<
    MetadataTargetDraftEntry["target"],
    { kind: "ExistingOccurrence" }
  >;
} {
  const target = existingOccurrenceTargetFromOccurrence(current);
  if (target.kind !== "targetable") throw new Error(target.reason);
  return { target: target.target, edit };
}

function targets(
  ...entries: MetadataTargetDraftEntry[]
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry, index) => [String(index), entry]),
  );
}

function set(value: MetadataValue): MetadataDraftEdit {
  return { intent: "Set", value };
}

function resolve(
  overrides: {
    metadata?: ReturnType<typeof mockMetadata>;
    occurrences?: MetadataOccurrence[] | "loading";
    targetDrafts?: TargetDraftCollection;
  } = {},
) {
  return resolveEffectiveGpsForFile({
    occurrences:
      overrides.occurrences ??
      occurrencesFromMetadataCollection(
        overrides.metadata ?? mockMetadata(BASE_RAW),
      ),
    targetDrafts: overrides.targetDrafts,
  });
}

describe("resolveEffectiveGpsForFile", () => {
  it("resolves on-disk raw GPS normally", () => {
    expect(resolve()).toEqual({ lat: 51, lon: 1 });
  });

  it("preserves positive zero for a north latitude reference", () => {
    const result = resolve({
      metadata: mockMetadata({
        "GPS:GPSLatitude": 0,
        "GPS:GPSLatitudeRef": "N",
        "GPS:GPSLongitude": 1,
        "GPS:GPSLongitudeRef": "E",
      }),
      occurrences: zeroOccurrences("N", "E"),
    });

    expect(Object.is(result.lat, 0)).toBe(true);
    expect(Object.is(result.lat, -0)).toBe(false);
  });

  it("preserves negative zero for a south latitude reference", () => {
    const result = resolve({
      metadata: mockMetadata({
        "GPS:GPSLatitude": 0,
        "GPS:GPSLatitudeRef": "S",
        "GPS:GPSLongitude": 1,
        "GPS:GPSLongitudeRef": "E",
      }),
      occurrences: zeroOccurrences("S", "E"),
    });

    expect(Object.is(result.lat, -0)).toBe(true);
    expect(Object.is(result.lat, 0)).toBe(false);
  });

  it("preserves positive zero for an east longitude reference", () => {
    const result = resolve({
      metadata: mockMetadata({
        "GPS:GPSLatitude": 1,
        "GPS:GPSLatitudeRef": "N",
        "GPS:GPSLongitude": 0,
        "GPS:GPSLongitudeRef": "E",
      }),
      occurrences: zeroOccurrences("N", "E"),
    });

    expect(Object.is(result.lon, 0)).toBe(true);
    expect(Object.is(result.lon, -0)).toBe(false);
  });

  it("preserves negative zero for a west longitude reference", () => {
    const result = resolve({
      metadata: mockMetadata({
        "GPS:GPSLatitude": 1,
        "GPS:GPSLatitudeRef": "N",
        "GPS:GPSLongitude": 0,
        "GPS:GPSLongitudeRef": "W",
      }),
      occurrences: zeroOccurrences("N", "W"),
    });

    expect(Object.is(result.lon, -0)).toBe(true);
    expect(Object.is(result.lon, 0)).toBe(false);
  });

  it("preserves negative zero from target-aware ExistingOccurrence reference drafts", () => {
    const occurrences = zeroOccurrences();
    const result = resolve({
      occurrences,
      targetDrafts: targets(
        existingEntry(occurrences[1], set(valueFor("S"))),
        existingEntry(occurrences[3], set(valueFor("W"))),
      ),
    });

    expect(Object.is(result.lat, -0)).toBe(true);
    expect(Object.is(result.lon, -0)).toBe(true);
  });

  it("preserves negative zero from target-aware NewProperty reference drafts", () => {
    const occurrences = [
      occurrence(GPS_IDS.latitude, valueFor(0)),
      occurrence(GPS_IDS.longitude, valueFor(0)),
    ];
    const result = resolve({
      occurrences,
      targetDrafts: targets(
        {
          target: {
            kind: "NewProperty",
            schema_id: GPS_IDS.latitudeRef,
            write_target: {
              group1: "XMP-test",
              group7: "ID-Test",
              tag_name: "TestTag",
            },
          },
          edit: set(valueFor("S")),
        },
        {
          target: {
            kind: "NewProperty",
            schema_id: GPS_IDS.longitudeRef,
            write_target: {
              group1: "XMP-test",
              group7: "ID-Test",
              tag_name: "TestTag",
            },
          },
          edit: set(valueFor("W")),
        },
      ),
    });

    expect(Object.is(result.lat, -0)).toBe(true);
    expect(Object.is(result.lon, -0)).toBe(true);
  });

  it("returns null coordinates while authoritative occurrences are loading", () => {
    expect(
      resolveEffectiveGpsForFile({
        occurrences: "loading",
        targetDrafts: undefined,
      }),
    ).toEqual({ lat: null, lon: null });
  });

  it("overlays uniquely resolved authoritative occurrence values", () => {
    const occurrences = baseOccurrences();
    occurrences[0] = occurrence(GPS_IDS.latitude, valueFor(52));
    occurrences[2] = occurrence(GPS_IDS.longitude, valueFor(2));
    expect(resolve({ occurrences })).toEqual({ lat: 52, lon: 2 });
  });

  it("overlays valid target-aware ExistingOccurrence coordinate drafts", () => {
    const occurrences = baseOccurrences();
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(
          existingEntry(occurrences[0], set(valueFor(52))),
          existingEntry(occurrences[2], set(valueFor(2))),
        ),
      }),
    ).toEqual({ lat: 52, lon: 2 });
  });

  it("uses target-aware reference drafts to change coordinate signs", () => {
    const occurrences = baseOccurrences();
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(
          existingEntry(occurrences[1], set(valueFor("S"))),
          existingEntry(occurrences[3], set(valueFor("W"))),
        ),
      }),
    ).toEqual({ lat: -51, lon: -1 });
  });

  it("uses missing reference fields represented by NewProperty targets", () => {
    const occurrences = [
      occurrence(GPS_IDS.latitude, valueFor(51)),
      occurrence(GPS_IDS.longitude, valueFor(1)),
    ];
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(
          {
            target: {
              kind: "NewProperty",
              schema_id: GPS_IDS.latitudeRef,
              write_target: {
                group1: "XMP-test",
                group7: "ID-Test",
                tag_name: "TestTag",
              },
            },
            edit: set(valueFor("S")),
          },
          {
            target: {
              kind: "NewProperty",
              schema_id: GPS_IDS.longitudeRef,
              write_target: {
                group1: "XMP-test",
                group7: "ID-Test",
                tag_name: "TestTag",
              },
            },
            edit: set(valueFor("W")),
          },
        ),
      }),
    ).toEqual({ lat: -51, lon: -1 });
  });

  it("turns a valid target-aware coordinate Delete into null coordinates", () => {
    const occurrences = baseOccurrences();
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(
          existingEntry(occurrences[0], { intent: "Delete", value: null }),
        ),
      }),
    ).toEqual({ lat: null, lon: null });
  });

  it("ignores altitude-only targets when resolving coordinates", () => {
    const occurrences = baseOccurrences();
    occurrences.push(occurrence(GPS_IDS.altitude, valueFor(10)));
    const altitude = occurrences.find(
      (entry) => entry.schema_id.tag_id === GPS_IDS.altitude.tag_id,
    )!;
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(existingEntry(altitude, set(valueFor(20)))),
      }),
    ).toEqual({ lat: 51, lon: 1 });
  });

  it("ignores a stale ExistingOccurrence target", () => {
    const occurrences = baseOccurrences();
    const entry = existingEntry(occurrences[0], set(valueFor(52)));
    entry.target = {
      ...entry.target,
      occurrence_id: { ...entry.target.occurrence_id, copy: 9 },
    };
    expect(resolve({ occurrences, targetDrafts: targets(entry) })).toEqual({
      lat: 51,
      lon: 1,
    });
  });

  it("ignores a changed runtime selector target", () => {
    const occurrences = baseOccurrences();
    const entry = existingEntry(occurrences[0], set(valueFor(52)));
    entry.target = {
      ...entry.target,
      write_target: { ...entry.target.write_target, tag_name: "Other" },
    };
    expect(resolve({ occurrences, targetDrafts: targets(entry) })).toEqual({
      lat: 51,
      lon: 1,
    });
  });

  it("ignores a changed embedded schema target", () => {
    const occurrences = baseOccurrences();
    const entry = existingEntry(occurrences[0], set(valueFor(52)));
    entry.target = { ...entry.target, schema_id: GPS_IDS.longitude };
    expect(resolve({ occurrences, targetDrafts: targets(entry) })).toEqual({
      lat: 51,
      lon: 1,
    });
  });

  it("never selects a multiply-resolved GPS schema", () => {
    const occurrences = baseOccurrences();
    const duplicate = occurrence(GPS_IDS.latitude, valueFor(60), {
      id: { ...occurrences[0].id, copy: 1 },
    });
    expect(
      resolve({
        occurrences: [...occurrences, duplicate],
        targetDrafts: targets(existingEntry(occurrences[0], set(valueFor(52)))),
      }),
    ).toEqual({ lat: null, lon: null });
  });

  it("never selects among multiple exact-schema target owners", () => {
    const occurrences = baseOccurrences();
    const first = existingEntry(occurrences[0], set(valueFor(52)));
    const second = existingEntry(occurrences[0], set(valueFor(53)));
    expect(
      resolve({ occurrences, targetDrafts: targets(first, second) }),
    ).toEqual({ lat: 51, lon: 1 });
  });

  it("does not mutate occurrences or target drafts", () => {
    const occurrences = baseOccurrences();
    const targetDrafts = targets(
      existingEntry(occurrences[0], set(valueFor(52))),
    );
    const before = structuredClone({ occurrences, targetDrafts });

    resolveEffectiveGpsForFile({ occurrences, targetDrafts });

    expect({ occurrences, targetDrafts }).toEqual(before);
  });
});
