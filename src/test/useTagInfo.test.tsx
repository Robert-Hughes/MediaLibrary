import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  useTagInfo,
  useTagInfos,
  resolveTagInfosExact,
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
  _ensureTagInfoCacheEntry,
} from "../hooks/useTagInfo";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import type { SchemaDefinitionId, TagInfo } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  _clearTagInfoCache();
});

describe("useTagInfo exact lookup hook", () => {
  it("invokes get_tag_info with id, not tag", async () => {
    const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const mockTagInfo: TagInfo = {
      id,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Manufacturer description",
    };

    vi.mocked(invoke).mockResolvedValueOnce(mockTagInfo);

    const { result } = renderHook(() => useTagInfo(id));

    expect(result.current).toBe("loading");
    expect(invoke).toHaveBeenCalledWith("get_tag_info", { id });

    // Ensure the old `{ tag: ... }` argument is never sent
    const calls = vi.mocked(invoke).mock.calls;
    expect(calls[0][1]).not.toHaveProperty("tag");

    await waitFor(() => {
      expect(result.current).toEqual(mockTagInfo);
    });
  });

  it("shares one request and cache entry for two value-equal ID objects", async () => {
    const id1: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const id2: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };

    const mockTagInfo: TagInfo = {
      id: id1,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Manufacturer",
    };

    vi.mocked(invoke).mockResolvedValue(mockTagInfo);

    const { result: r1 } = renderHook(() => useTagInfo(id1));
    const { result: r2 } = renderHook(() => useTagInfo(id2));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(r1.current).toBe("loading");
    expect(r2.current).toBe("loading");

    await waitFor(() => {
      expect(r1.current).toEqual(mockTagInfo);
      expect(r2.current).toEqual(mockTagInfo);
    });
  });

  it("does not refetch when rerendering with a newly allocated equal ID", async () => {
    const mockTagInfo: TagInfo = {
      id: { table: "Exif::Main", tag_id: "271" },
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Manufacturer",
    };

    vi.mocked(invoke).mockResolvedValue(mockTagInfo);

    const { result, rerender } = renderHook(({ id }) => useTagInfo(id), {
      initialProps: { id: { table: "Exif::Main", tag_id: "271" } },
    });

    await waitFor(() => {
      expect(result.current).toEqual(mockTagInfo);
    });

    rerender({ id: { table: "Exif::Main", tag_id: "271" } });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("uses separate cache entries for IDs with same friendly name but different exact identities", async () => {
    const id1: SchemaDefinitionId = {
      table: "Canon::CameraInfo40D",
      tag_id: "4",
    };
    const id2: SchemaDefinitionId = {
      table: "Canon::CameraInfo5D",
      tag_id: "4",
    };

    const tag1: TagInfo = {
      id: id1,
      group: "Canon",
      name: "WhiteBalance",
      writable: true,
      kind: { kind: "Text" },
      description: "WB 40D",
    };

    const tag2: TagInfo = {
      id: id2,
      group: "Canon",
      name: "WhiteBalance",
      writable: true,
      kind: { kind: "Text" },
      description: "WB 5D",
    };

    vi.mocked(invoke).mockResolvedValueOnce(tag1).mockResolvedValueOnce(tag2);

    const { result: r1 } = renderHook(() => useTagInfo(id1));
    const { result: r2 } = renderHook(() => useTagInfo(id2));

    expect(invoke).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(r1.current).toEqual(tag1);
      expect(r2.current).toEqual(tag2);
    });
  });

  it("treats index: undefined and an omitted index as equivalent", async () => {
    const idOmitted: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
    };
    const idUndefined: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
      index: undefined,
    };

    const mockTagInfo: TagInfo = {
      id: idOmitted,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Manufacturer",
    };

    vi.mocked(invoke).mockResolvedValue(mockTagInfo);

    const { result: r1 } = renderHook(() => useTagInfo(idOmitted));
    const { result: r2 } = renderHook(() => useTagInfo(idUndefined));

    expect(invoke).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(r1.current).toEqual(mockTagInfo);
      expect(r2.current).toEqual(mockTagInfo);
    });
  });

  it("distinguishes index: 0 from an omitted index", async () => {
    const idOmitted: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
    };
    const idZero: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
      index: 0,
    };

    const tagOmitted: TagInfo = {
      id: idOmitted,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Omitted",
    };

    const tagZero: TagInfo = {
      id: idZero,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Index 0",
    };

    vi.mocked(invoke)
      .mockResolvedValueOnce(tagOmitted)
      .mockResolvedValueOnce(tagZero);

    const { result: r1 } = renderHook(() => useTagInfo(idOmitted));
    const { result: r2 } = renderHook(() => useTagInfo(idZero));

    expect(invoke).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(r1.current).toEqual(tagOmitted);
      expect(r2.current).toEqual(tagZero);
    });
  });

  it("returns null when a missing exact schema definition is queried", async () => {
    const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "999" };
    vi.mocked(invoke).mockResolvedValue(null);

    const { result } = renderHook(() => useTagInfo(id));

    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it("useTagInfos deduplicates equal IDs and returns entries keyed by schemaDefinitionIdToken", async () => {
    const id1: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const id2: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };
    const id3: SchemaDefinitionId = { table: "Exif::Main", tag_id: "272" };

    const tag1: TagInfo = {
      id: id1,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Make",
    };
    const tag3: TagInfo = {
      id: id3,
      group: "IFD0",
      name: "Model",
      writable: true,
      kind: { kind: "Text" },
      description: "Model",
    };

    vi.mocked(invoke).mockResolvedValueOnce(tag1).mockResolvedValueOnce(tag3);

    const { result } = renderHook(() => useTagInfos([id1, id2, id3]));

    expect(invoke).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(result.current).toEqual({
        [schemaDefinitionIdToken(id1)]: tag1,
        [schemaDefinitionIdToken(id3)]: tag3,
      });
    });
  });

  it("exact cache test helpers insert TagInfo.id correctly and _ensureTagInfoCacheEntry does not overwrite", () => {
    const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "271" };

    // Test _setTagInfoCacheEntry with Omit<TagInfo, "id">
    _setTagInfoCacheEntry(id, {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Make",
    });

    const { result: r1 } = renderHook(() => useTagInfo(id));
    expect(r1.current).toEqual({
      id,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Make",
    });

    // Test that _ensureTagInfoCacheEntry does not overwrite an existing value
    _ensureTagInfoCacheEntry(id, {
      id,
      group: "IFD0",
      name: "Model",
      writable: true,
      kind: { kind: "Text" },
      description: "Overwritten Model?",
    });

    const { result: r2 } = renderHook(() => useTagInfo(id));
    expect(r2.current).toEqual({
      id,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: "Make",
    });
  });

  describe("resolveTagInfosExact", () => {
    const info = (id: SchemaDefinitionId, name = "Name"): TagInfo => ({
      id,
      group: "Shared",
      name,
      writable: true,
      kind: { kind: "Text" },
      description: `${name} description`,
    });

    it("reuses resolved and missing cache entries without Tauri", async () => {
      const found = { table: "A", tag_id: "1" };
      const missing = { table: "A", tag_id: "2" };
      _setTagInfoCacheEntry(found, info(found));
      _setTagInfoCacheEntry(missing, null);

      const result = await resolveTagInfosExact([found, missing]);

      expect(invoke).not.toHaveBeenCalled();
      expect(result[schemaDefinitionIdToken(found)]).toEqual(info(found));
      expect(result[schemaDefinitionIdToken(missing)]).toBeNull();
    });

    it("deduplicates equal IDs and batches several absent exact IDs", async () => {
      const a = { table: "A", tag_id: "1" };
      const equalA = { ...a, index: undefined };
      const zero = { table: "A", tag_id: "1", index: 0 };
      const sameNameOtherTable = { table: "B", tag_id: "1" };
      vi.mocked(invoke).mockResolvedValueOnce([
        info(a),
        info(zero),
        info(sameNameOtherTable),
      ]);

      await resolveTagInfosExact([a, equalA, zero, sameNameOtherTable]);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("get_tag_infos", {
        ids: [a, zero, sameNameOtherTable],
      });
    });

    it("primes the hook cache and caches requested omissions as missing", async () => {
      const found = { table: "A", tag_id: "1" };
      const missing = { table: "A", tag_id: "404" };
      vi.mocked(invoke).mockResolvedValueOnce([info(found)]);

      await resolveTagInfosExact([found, missing]);
      const { result: foundHook } = renderHook(() => useTagInfo(found));
      const { result: missingHook } = renderHook(() => useTagInfo(missing));

      expect(foundHook.current).toEqual(info(found));
      expect(missingHook.current).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("shares a pending batch across callers and prevents a duplicate hook lookup", async () => {
      const id = { table: "A", tag_id: "1" };
      let finish!: (value: TagInfo[]) => void;
      vi.mocked(invoke).mockReturnValueOnce(
        new Promise<TagInfo[]>((resolve) => {
          finish = resolve;
        }),
      );

      const first = resolveTagInfosExact([id]);
      const second = resolveTagInfosExact([{ ...id }]);
      renderHook(() => useTagInfo(id));
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("get_tag_infos", { ids: [id] });

      finish([info(id)]);
      await expect(Promise.all([first, second])).resolves.toEqual([
        { [schemaDefinitionIdToken(id)]: info(id) },
        { [schemaDefinitionIdToken(id)]: info(id) },
      ]);
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("waits for an existing single-ID request", async () => {
      const id = { table: "A", tag_id: "1" };
      let finish!: (value: TagInfo) => void;
      vi.mocked(invoke).mockReturnValueOnce(
        new Promise<TagInfo>((resolve) => {
          finish = resolve;
        }),
      );
      renderHook(() => useTagInfo(id));
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

      const batch = resolveTagInfosExact([id]);
      expect(invoke).toHaveBeenCalledTimes(1);
      finish(info(id));
      await expect(batch).resolves.toEqual({
        [schemaDefinitionIdToken(id)]: info(id),
      });
    });

    it("allows retry after failure without erasing resolved values", async () => {
      const resolvedId = { table: "A", tag_id: "1" };
      const retryId = { table: "A", tag_id: "2" };
      _setTagInfoCacheEntry(resolvedId, info(resolvedId));
      vi.mocked(invoke)
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce([info(retryId)]);

      await expect(resolveTagInfosExact([resolvedId, retryId])).rejects.toThrow(
        "offline",
      );
      const retried = await resolveTagInfosExact([resolvedId, retryId]);

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(retried[schemaDefinitionIdToken(resolvedId)]).toEqual(
        info(resolvedId),
      );
      expect(retried[schemaDefinitionIdToken(retryId)]).toEqual(info(retryId));
    });
  });
});
