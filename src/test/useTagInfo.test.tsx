import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearTagInfoCache,
  _ensureTagInfoCacheEntry,
  _setTagInfoCacheEntry,
  resolveTagInfosExact,
  useTagInfo,
  useTagInfos,
} from "../hooks/useTagInfo";
import { installTagSchemaRegistry } from "../tagSchemaRegistry";
import type { SchemaDefinitionId, TagInfo } from "../types";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

function info(
  id: SchemaDefinitionId,
  name = "Name",
  description = `${name} description`,
): TagInfo {
  return {
    id,
    group0: "EXIF",
    group: "IFD0",
    name,
    writable: true,
    kind: { kind: "Text" },
    description,
  };
}

beforeEach(() => {
  _clearTagInfoCache();
});

describe("frontend tag schema registry", () => {
  it("reports loading until the startup registry is installed", () => {
    const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const { result } = renderHook(() => useTagInfo(id));
    expect(result.current).toBe("loading");
  });

  it("updates mounted hooks when startup installs the complete registry", () => {
    const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const make = info(id, "Make");
    const { result } = renderHook(() => useTagInfo(id));

    act(() => installTagSchemaRegistry([make]));

    expect(result.current).toEqual(make);
  });

  it("returns null for an exact schema ID absent from an installed registry", () => {
    const missing: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "999",
    };
    installTagSchemaRegistry([]);

    const { result } = renderHook(() => useTagInfo(missing));

    expect(result.current).toBeNull();
  });

  it("uses value identity rather than object identity for SchemaDefinitionId", () => {
    const stored: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
    };
    const equal: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
      index: undefined,
    };
    const make = info(stored, "Make");
    installTagSchemaRegistry([make]);

    const { result } = renderHook(() => useTagInfo(equal));

    expect(result.current).toEqual(make);
  });

  it("keeps equal friendly names at different exact schema identities separate", () => {
    const first: SchemaDefinitionId = {
      table: "Canon::CameraInfo40D",
      tag_id: "4",
    };
    const second: SchemaDefinitionId = {
      table: "Canon::CameraInfo5D",
      tag_id: "4",
    };
    const firstInfo = info(first, "WhiteBalance", "WB 40D");
    const secondInfo = info(second, "WhiteBalance", "WB 5D");
    installTagSchemaRegistry([firstInfo, secondInfo]);

    const firstHook = renderHook(() => useTagInfo(first));
    const secondHook = renderHook(() => useTagInfo(second));

    expect(firstHook.result.current).toEqual(firstInfo);
    expect(secondHook.result.current).toEqual(secondInfo);
  });

  it("distinguishes explicit index zero from an omitted index", () => {
    const omitted: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
    };
    const zero: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
      index: 0,
    };
    const omittedInfo = info(omitted, "Make", "unindexed");
    const zeroInfo = info(zero, "Make", "index zero");
    installTagSchemaRegistry([omittedInfo, zeroInfo]);

    expect(renderHook(() => useTagInfo(omitted)).result.current).toEqual(
      omittedInfo,
    );
    expect(renderHook(() => useTagInfo(zero)).result.current).toEqual(zeroInfo);
  });

  it("batch lookup deduplicates exact IDs and stays entirely local", () => {
    const first: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const equalFirst: SchemaDefinitionId = { ...first, index: undefined };
    const second: SchemaDefinitionId = { table: "Exif::Main", tag_id: "272" };
    const make = info(first, "Make");
    const model = info(second, "Model");
    installTagSchemaRegistry([make, model]);

    const { result } = renderHook(() =>
      useTagInfos([first, equalFirst, second]),
    );

    expect(result.current).toEqual({
      [schemaDefinitionIdToken(first)]: make,
      [schemaDefinitionIdToken(second)]: model,
    });
  });

  it("resolveTagInfosExact returns registry results without asynchronous IPC", async () => {
    const found: SchemaDefinitionId = { table: "A", tag_id: "1" };
    const missing: SchemaDefinitionId = { table: "A", tag_id: "404" };
    const foundInfo = info(found);
    installTagSchemaRegistry([foundInfo]);

    await expect(
      resolveTagInfosExact([found, { ...found }, missing]),
    ).resolves.toEqual({
      [schemaDefinitionIdToken(found)]: foundInfo,
      [schemaDefinitionIdToken(missing)]: null,
    });
  });

  it("test helpers preserve exact IDs and ensure does not overwrite", () => {
    const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    _setTagInfoCacheEntry(id, {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Make",
    });
    _ensureTagInfoCacheEntry(id, info(id, "Model"));

    const { result } = renderHook(() => useTagInfo(id));

    expect(result.current).toMatchObject({
      id,
      name: "Make",
      description: "Make",
    });
  });
});
