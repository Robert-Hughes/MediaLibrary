import { describe, expect, it } from "vitest";

import type { MetadataOccurrenceId } from "../types/generated/MetadataOccurrenceId";
import {
  compareMetadataOccurrenceIds,
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
    runtime_tag_id: "282",
    tag_id_scope: { table: "TestFixture::Runtime", tag_id: "282", index: null },
    copy: 0,
    ...overrides,
  };
}

describe("metadata occurrence identity", () => {
  it("orders null documents before non-null documents", () => {
    expect(
      compareMetadataOccurrenceIds(id(), id({ document: "" })),
    ).toBeLessThan(0);
  });

  it.each(["document", "path", "runtime_tag_id"] as const)(
    "orders %s by Unicode scalar value like Rust rather than UTF-16 code units",
    (field) => {
      const bmp = id({ [field]: "\uE000" });
      const supplementary = id({ [field]: "\u{10000}" });
      expect(compareMetadataOccurrenceIds(bmp, supplementary)).toBeLessThan(0);
      expect(compareMetadataOccurrenceIds(supplementary, bmp)).toBeGreaterThan(
        0,
      );
    },
  );

  it("compares copy numerically after string components", () => {
    expect(
      compareMetadataOccurrenceIds(id({ copy: 2 }), id({ copy: 10 })),
    ).toBeLessThan(0);
  });

  it("compares every component", () => {
    expect(metadataOccurrenceIdEquals(id(), id())).toBe(true);
    expect(metadataOccurrenceIdEquals(id(), id({ document: "Doc1" }))).toBe(
      false,
    );
    expect(
      metadataOccurrenceIdEquals(id(), id({ path: "JPEG-APP1-IFD1" })),
    ).toBe(false);
    expect(
      metadataOccurrenceIdEquals(id(), id({ runtime_tag_id: "283" })),
    ).toBe(false);
    expect(
      metadataOccurrenceIdEquals(
        id(),
        id({
          tag_id_scope: {
            ...id().tag_id_scope,
            table: "TestFixture::Other",
          },
        }),
      ),
    ).toBe(false);
    expect(
      metadataOccurrenceIdEquals(
        id(),
        id({ tag_id_scope: { ...id().tag_id_scope, tag_id: "283" } }),
      ),
    ).toBe(false);
    expect(
      metadataOccurrenceIdEquals(
        id(),
        id({ tag_id_scope: { ...id().tag_id_scope, index: 0 } }),
      ),
    ).toBe(false);
    expect(metadataOccurrenceIdEquals(id(), id({ copy: 1 }))).toBe(false);
  });

  it("orders wrapped scope table, tag ID, and optional index like Rust", () => {
    const scope = id().tag_id_scope;
    expect(
      compareMetadataOccurrenceIds(
        id({ tag_id_scope: { ...scope, table: "\uE000" } }),
        id({ tag_id_scope: { ...scope, table: "\u{10000}" } }),
      ),
    ).toBeLessThan(0);
    expect(
      compareMetadataOccurrenceIds(
        id({ tag_id_scope: { ...scope, tag_id: "1" } }),
        id({ tag_id_scope: { ...scope, tag_id: "2" } }),
      ),
    ).toBeLessThan(0);
    expect(
      compareMetadataOccurrenceIds(
        id({ tag_id_scope: { ...scope, index: null } }),
        id({ tag_id_scope: { ...scope, index: 0 } }),
      ),
    ).toBeLessThan(0);
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

  it("tokens preserve scope case and distinguish absent from index zero", () => {
    const scope = id().tag_id_scope;
    const absent = id({ tag_id_scope: { ...scope, index: null } });
    const zero = id({ tag_id_scope: { ...scope, index: 0 } });
    const differentCase = id({
      tag_id_scope: { ...scope, table: scope.table.toLowerCase() },
    });

    expect(metadataOccurrenceIdToken(absent)).not.toBe(
      metadataOccurrenceIdToken(zero),
    );
    expect(metadataOccurrenceIdToken(absent)).not.toBe(
      metadataOccurrenceIdToken(differentCase),
    );
    expect(
      metadataOccurrenceIdFromToken(metadataOccurrenceIdToken(zero)),
    ).toEqual(zero);
  });

  it("cannot collide when strings contain delimiter-like characters", () => {
    const first = id({ document: 'a","b', path: "c/d", runtime_tag_id: "e,0" });
    const second = id({
      document: "a",
      path: '","b,c/d',
      runtime_tag_id: "e,0",
    });
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
    '[null,"path","tag",["table","id"],0]',
    '[null,"path","tag",["table","id",-1],0]',
  ])("rejects invalid token %s", (token) => {
    expect(() => metadataOccurrenceIdFromToken(token)).toThrow();
  });

  it("formats every component for diagnostics", () => {
    expect(formatMetadataOccurrenceIdForDiagnostics(id())).toBe(
      "document <main> / path JPEG-APP1-IFD0 / runtime tag 282 / wrapped scope TestFixture::Runtime ID 282 index <none> / copy 0",
    );
    expect(
      formatMetadataOccurrenceIdForDiagnostics(
        id({
          document: "Doc1",
          path: "P",
          runtime_tag_id: "T",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "T",
            index: null,
          },
          copy: 7,
        }),
      ),
    ).toBe(
      "document Doc1 / path P / runtime tag T / wrapped scope TestFixture::Runtime ID T index <none> / copy 7",
    );
  });

  it("does not substitute the collection token for domain identity", () => {
    const domainApi = (_occurrenceId: MetadataOccurrenceId): void => undefined;
    domainApi(id());
    // @ts-expect-error Collection tokens are not domain IDs at API boundaries.
    domainApi(metadataOccurrenceIdToken(id()));
  });
});
