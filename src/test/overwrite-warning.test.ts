import { describe, it, expect } from "vitest";
import { buildOverwriteWarning } from "../components/overwriteWarning";

describe("buildOverwriteWarning", () => {
  const describeFlow = {
    title: "Overwrite AI description?",
    subjectSingular: "image",
    subjectPlural: "photos",
    dataPhrase: "an AI description",
    actionSingle: "Generating a new one will overwrite the existing one.",
    actionPluralAll: "Generating new ones will overwrite the existing ones.",
  };

  const geocodeFlow = {
    title: "Overwrite location data?",
    subjectSingular: "photo",
    dataPhrase: "location data",
    actionSingle:
      "Reverse-geocoding will overwrite all location name fields (City, State, Country, etc. — GPS coordinates are not touched) with drafts; fields the geocoder doesn't return will be cleared.",
    actionPluralPartial:
      "Reverse-geocoding will overwrite all location name fields (City, State, Country, etc. — GPS coordinates are not touched) with drafts for those photos; fields the geocoder doesn't return will be cleared.",
  };

  it("returns null when no photos already have data", () => {
    expect(
      buildOverwriteWarning({
        existingCount: 0,
        totalCount: 4,
        ...describeFlow,
      }),
    ).toBeNull();
  });

  it("returns null when totalCount is 0 (defensive)", () => {
    expect(
      buildOverwriteWarning({
        existingCount: 0,
        totalCount: 0,
        ...describeFlow,
      }),
    ).toBeNull();
  });

  it("returns null when existingCount exceeds totalCount (defensive)", () => {
    expect(
      buildOverwriteWarning({
        existingCount: 5,
        totalCount: 3,
        ...describeFlow,
      }),
    ).toBeNull();
  });

  it("single-photo branch uses subjectSingular and actionSingle", () => {
    const w = buildOverwriteWarning({
      existingCount: 1,
      totalCount: 1,
      ...describeFlow,
    });
    expect(w).toEqual({
      title: "Overwrite AI description?",
      body: "This image already has an AI description. Generating a new one will overwrite the existing one.",
    });
  });

  it("all-of-many branch uses actionPluralAll", () => {
    const w = buildOverwriteWarning({
      existingCount: 3,
      totalCount: 3,
      ...describeFlow,
    });
    expect(w?.body).toBe(
      "All 3 selected photos already have an AI description. Generating new ones will overwrite the existing ones.",
    );
  });

  it("partial-of-many branch with existing > 1 says 'have'", () => {
    const w = buildOverwriteWarning({
      existingCount: 2,
      totalCount: 5,
      ...describeFlow,
    });
    expect(w?.body).toBe(
      "2 of 5 selected photos already have an AI description. Generating new ones will overwrite the existing ones.",
    );
  });

  it("partial-of-many branch with existing == 1 says 'has'", () => {
    const w = buildOverwriteWarning({
      existingCount: 1,
      totalCount: 5,
      ...describeFlow,
    });
    expect(w?.body).toBe(
      "1 of 5 selected photos already has an AI description. Generating new ones will overwrite the existing ones.",
    );
  });

  it("body does not append 'Continue?' (the dialog's Confirm button provides that affordance)", () => {
    const w = buildOverwriteWarning({
      existingCount: 1,
      totalCount: 1,
      ...describeFlow,
    });
    expect(w?.body).not.toMatch(/Continue\?/);
  });

  it("falls back to actionSingle when actionPluralAll omitted", () => {
    const w = buildOverwriteWarning({
      existingCount: 3,
      totalCount: 3,
      ...geocodeFlow,
    });
    // No actionPluralAll defined → reuse actionSingle.
    expect(w?.body).toContain(
      "Reverse-geocoding will overwrite all location name fields",
    );
    expect(w?.body).not.toContain("for those photos");
  });

  it("uses actionPluralPartial in partial branch", () => {
    const w = buildOverwriteWarning({
      existingCount: 2,
      totalCount: 5,
      ...geocodeFlow,
    });
    expect(w?.body).toContain("for those photos");
  });

  it("defaults subjectPlural to subjectSingular + 's'", () => {
    const w = buildOverwriteWarning({
      existingCount: 3,
      totalCount: 3,
      ...geocodeFlow,
    });
    expect(w?.body).toContain("All 3 selected photos already have");
  });

  it("preserves caller-supplied subjectPlural", () => {
    const w = buildOverwriteWarning({
      existingCount: 3,
      totalCount: 3,
      title: "T",
      subjectSingular: "deer",
      subjectPlural: "deer",
      dataPhrase: "antlers",
      actionSingle: "Replacing.",
    });
    expect(w?.body).toContain("All 3 selected deer already have antlers");
  });
});
