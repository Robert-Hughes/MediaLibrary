import { describe, expect, it } from "vitest";

import type { MetadataOccurrenceId } from "../types/generated/MetadataOccurrenceId";
import {
  formatMetadataOccurrenceIdForDiagnostics,
  metadataOccurrenceIdEquals,
  metadataOccurrenceIdFromToken,
  metadataOccurrenceIdToken,
} from "../utils/metadataOccurrenceId";

function id(
  overrides: Partial<MetadataOccurrenceId> = {},
): MetadataOccurrenceId {
  return {
    document: null,
    path: "JPEG-APP1-IFD0",
    tag_id: "282",
    copy: 0,
    ...overrides,
  };
}

describe("metadata occurrence identity", () => {
  it("compares all four components", () => {
    expect(metadataOccurrenceIdEquals(id(), id())).toBe(true);
    expect(metadataOccurrenceIdEquals(id(), id({ document: "Doc1" }))).toBe(
      false,
    );
    expect(
      metadataOccurrenceIdEquals(id(), id({ path: "JPEG-APP1-IFD1" })),
    ).toBe(false);
    expect(metadataOccurrenceIdEquals(id(), id({ tag_id: "283" }))).toBe(false);
    expect(metadataOccurrenceIdEquals(id(), id({ copy: 1 }))).toBe(false);
  });

  it("normalises an absent document to null in collection tokens", () => {
    const missingDocument = {
      ...id(),
      document: undefined,
    } as unknown as MetadataOccurrenceId;

    expect(metadataOccurrenceIdToken(missingDocument)).toBe(
      metadataOccurrenceIdToken(id()),
    );
    expect(
      metadataOccurrenceIdFromToken(metadataOccurrenceIdToken(missingDocument))
        .document,
    ).toBe(null);
  });

  it("round-trips a token", () => {
    const original = id({ document: "Doc1", copy: 2 });
    expect(
      metadataOccurrenceIdFromToken(metadataOccurrenceIdToken(original)),
    ).toEqual(original);
  });

  it("cannot collide when strings contain delimiter-like characters", () => {
    const first = id({ document: 'a","b', path: "c/d", tag_id: "e,0" });
    const second = id({ document: "a", path: '","b,c/d', tag_id: "e,0" });
    expect(metadataOccurrenceIdToken(first)).not.toBe(
      metadataOccurrenceIdToken(second),
    );
    expect(
      metadataOccurrenceIdFromToken(metadataOccurrenceIdToken(first)),
    ).toEqual(first);
  });

  it.each([
    "not JSON",
    "{}",
    "[]",
    '[null,"path","tag"]',
    '[null,"path","tag",0,"extra"]',
    '[false,"path","tag",0]',
    '[null,1,"tag",0]',
    '[null,"path",1,0]',
    '[null,"path","tag",-1]',
    '[null,"path","tag",1.5]',
    '[null,"path","tag","0"]',
  ])("rejects invalid token %s", (token) => {
    expect(() => metadataOccurrenceIdFromToken(token)).toThrow();
  });

  it("formats every component for diagnostics", () => {
    expect(formatMetadataOccurrenceIdForDiagnostics(id())).toBe(
      "document <main> / path JPEG-APP1-IFD0 / tag 282 / copy 0",
    );
    expect(
      formatMetadataOccurrenceIdForDiagnostics(
        id({ document: "Doc1", path: "P", tag_id: "T", copy: 7 }),
      ),
    ).toBe("document Doc1 / path P / tag T / copy 7");
  });

  it("does not substitute the collection token for domain identity", () => {
    const domainApi = (_occurrenceId: MetadataOccurrenceId): void => undefined;
    domainApi(id());
    // @ts-expect-error Collection tokens are not domain IDs at API boundaries.
    domainApi(metadataOccurrenceIdToken(id()));
  });
});
