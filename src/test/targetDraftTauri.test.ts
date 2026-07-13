import { describe, expect, it, vi } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  type TargetDraftEditsByFile,
} from "../targetDraftEdits";
import {
  loadTargetDraftEditsV5,
  saveTargetDraftEditsV5,
  type TargetDraftTauriApi,
} from "../targetDraftTauri";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const schema = (table = "Exif::Main", tagId = "282"): SchemaDefinitionId => ({
  table,
  tag_id: tagId,
});

const existing = (
  path = "JPEG-APP1-IFD0",
  group1 = "IFD0",
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> => ({
  kind: "ExistingOccurrence",
  occurrence_id: {
    document: "Doc1",
    path,
    tag_id: "282",
    copy: 2,
  },
  schema_id: schema(),
  write_target: { group1, tag_name: "XResolution" },
});

const created = (
  id = schema(),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> => ({
  kind: "NewProperty",
  schema_id: id,
});

const setEdit = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: { kind: "Text", value },
  display: `display ${value}`,
});

const entry = (
  target: MetadataDraftTarget,
  value = "value",
): MetadataDraftEntryV5 => ({ target, edit: setEdit(value) });

const drafts = (
  wire: Record<string, MetadataDraftEntryV5[]>,
): TargetDraftEditsByFile => targetDraftsFromWire(wire);

describe("loadTargetDraftEditsV5", () => {
  it("uses the exact command and camel-case folder argument", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    await loadTargetDraftEditsV5({ invoke }, "C:/photos");
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("load_metadata_draft_edits_v5", {
      folderPath: "C:/photos",
    });
  });

  it("strictly loads unknown payloads while preserving complete targets", async () => {
    const oldTarget = existing();
    const newTarget = created(schema("XMP::Main", "title"));
    const invoke = vi
      .fn()
      .mockResolvedValue({ "photo.jpg": [entry(oldTarget), entry(newTarget)] });

    const loaded = await loadTargetDraftEditsV5({ invoke }, "folder");

    expect(
      loaded["photo.jpg"][metadataDraftTargetSlotToken(oldTarget)].target,
    ).toEqual(oldTarget);
    expect(
      loaded["photo.jpg"][metadataDraftTargetSlotToken(newTarget)].target,
    ).toEqual(newTarget);
  });

  it("loads a JSON-parsed __proto__ path as ordinary backend data", async () => {
    const target = created();
    const payload = JSON.parse(
      JSON.stringify(Object.fromEntries([["__proto__", [entry(target)]]])),
    );
    const loaded = await loadTargetDraftEditsV5(
      { invoke: vi.fn().mockResolvedValue(payload) },
      "folder",
    );

    expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(
      true,
    );
    expect(loaded.__proto__[metadataDraftTargetSlotToken(target)]).toEqual(
      entry(target),
    );
    expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
  });

  it("rejects invalid and duplicate payloads", async () => {
    await expect(
      loadTargetDraftEditsV5(
        { invoke: vi.fn().mockResolvedValue({ "bad.jpg": [{}] }) },
        "folder",
      ),
    ).rejects.toThrow(/bad\.jpg.*array index 0/);

    const target = existing();
    await expect(
      loadTargetDraftEditsV5(
        {
          invoke: vi.fn().mockResolvedValue({
            "duplicate.jpg": [entry(target), entry(structuredClone(target))],
          }),
        },
        "folder",
      ),
    ).rejects.toThrow(/Duplicate target draft slot/);
  });

  it("propagates backend rejection unchanged", async () => {
    const rejection = new Error("backend load failed");
    const promise = loadTargetDraftEditsV5(
      { invoke: vi.fn().mockRejectedValue(rejection) },
      "folder",
    );
    await expect(promise).rejects.toBe(rejection);
  });
});

describe("saveTargetDraftEditsV5", () => {
  it("uses the exact command, arguments, and deterministic wire order", async () => {
    const oldB = existing("IFD1", "IFD1");
    const oldA = existing("IFD0", "IFD0");
    const newB = created(schema("B", "tag"));
    const invoke = vi.fn().mockResolvedValue(undefined);
    const source = drafts({
      "z.jpg": [entry(newB), entry(oldB), entry(oldA)],
      "a.jpg": [entry(newB)],
    });
    const before = structuredClone(source);

    await saveTargetDraftEditsV5({ invoke }, "C:/photos", source);

    expect(invoke).toHaveBeenCalledOnce();
    const [command, args] = invoke.mock.calls[0] as [
      string,
      { folderPath: string; data: Record<string, MetadataDraftEntryV5[]> },
    ];
    expect(command).toBe("save_metadata_draft_edits_v5");
    expect(args.folderPath).toBe("C:/photos");
    expect(Object.keys(args.data)).toEqual(["a.jpg", "z.jpg"]);
    expect(args.data["z.jpg"].map(({ target }) => target)).toEqual([
      oldA,
      oldB,
      newB,
    ]);
    expect(
      args.data["z.jpg"].every(
        (wireEntry) =>
          Object.keys(wireEntry).sort().join(",") === "edit,target" &&
          !("slot" in wireEntry) &&
          !("slot_token" in wireEntry),
      ),
    ).toBe(true);
    expect(source).toEqual(before);
  });

  it("invokes Tauri with __proto__ as an own enumerable data property", async () => {
    const target = created();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const source = drafts(
      Object.fromEntries([["__proto__", [entry(target, "reserved")]]]),
    );

    await saveTargetDraftEditsV5({ invoke }, "folder", source);

    const args = invoke.mock.calls[0][1] as {
      data: Record<string, MetadataDraftEntryV5[]>;
    };
    expect(Object.getOwnPropertyDescriptor(args.data, "__proto__")).toEqual({
      value: [entry(target, "reserved")],
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(args.data)).toBe(Object.prototype);
  });

  it("rejects malformed keys before invoke", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await expect(
      saveTargetDraftEditsV5({ invoke }, "folder", {
        "photo.jpg": { wrong: entry(existing()) },
      }),
    ).rejects.toThrow(/supplied record key 'wrong'/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects duplicate malformed collections before invoke", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const first = entry(existing());
    const second = entry(structuredClone(first.target));
    await expect(
      saveTargetDraftEditsV5({ invoke }, "folder", {
        "photo.jpg": { first, second },
      }),
    ).rejects.toThrow(/duplicate target/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates backend rejection unchanged", async () => {
    const rejection = new Error("backend save failed");
    const promise = saveTargetDraftEditsV5(
      { invoke: vi.fn().mockRejectedValue(rejection) },
      "folder",
      drafts({ "photo.jpg": [entry(existing())] }),
    );
    await expect(promise).rejects.toBe(rejection);
  });
});

describe("target draft frontend/Tauri contract round-trip", () => {
  it("round-trips mixed logical slots through a JSON-cloned fake backend", async () => {
    let wireSnapshot: unknown = {};
    const api: TargetDraftTauriApi = {
      async invoke(command, args) {
        if (command === "save_metadata_draft_edits_v5") {
          wireSnapshot = JSON.parse(JSON.stringify(args?.data));
          return undefined;
        }
        if (command === "load_metadata_draft_edits_v5") {
          return JSON.parse(JSON.stringify(wireSnapshot));
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const ifd0 = existing("JPEG-APP1-IFD0", "IFD0");
    const ifd1 = existing("JPEG-APP1-IFD1", "IFD1");
    const newTarget = created(ifd0.schema_id);
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("photo.jpg", ifd0, setEdit("ifd0"));
    store.setMetadataTarget("photo.jpg", ifd1, setEdit("ifd1"));
    store.setMetadataTarget("photo.jpg", newTarget, setEdit("new"));

    const changedSnapshot = {
      ...ifd0,
      schema_id: schema("Changed::Schema", "999"),
      write_target: { group1: "IFD0", tag_name: "ChangedName" },
    };
    store.setMetadataTarget("photo.jpg", changedSnapshot, setEdit("changed"));
    const source = store.getAllMetadata();

    await saveTargetDraftEditsV5(api, "folder", source);
    const loaded = await loadTargetDraftEditsV5(api, "folder");

    expect(loaded).toEqual(source);
    expect(Object.keys(loaded["photo.jpg"])).toHaveLength(3);
    expect(
      loaded["photo.jpg"][metadataDraftTargetSlotToken(ifd0)].target,
    ).toEqual(changedSnapshot);
    expect(
      loaded["photo.jpg"][metadataDraftTargetSlotToken(ifd1)].target,
    ).toEqual(ifd1);
    expect(
      loaded["photo.jpg"][metadataDraftTargetSlotToken(newTarget)].target,
    ).toEqual(newTarget);
  });

  it("keeps __proto__ separate from an ordinary path through JSON cloning", async () => {
    let wireSnapshot: unknown = {};
    const api: TargetDraftTauriApi = {
      async invoke(command, args) {
        if (command === "save_metadata_draft_edits_v5") {
          wireSnapshot = JSON.parse(JSON.stringify(args?.data));
          return undefined;
        }
        if (command === "load_metadata_draft_edits_v5") {
          return JSON.parse(JSON.stringify(wireSnapshot));
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const reserved = entry(created(), "reserved");
    const ordinary = entry(existing(), "ordinary");
    const source = drafts(
      Object.fromEntries([
        ["__proto__", [reserved]],
        ["ordinary/photo.jpg", [ordinary]],
      ]),
    );

    await saveTargetDraftEditsV5(api, "folder", source);
    const loaded = await loadTargetDraftEditsV5(api, "folder");

    expect(Object.keys(loaded)).toEqual(["__proto__", "ordinary/photo.jpg"]);
    expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(
      true,
    );
    expect(loaded.__proto__).toEqual(source.__proto__);
    expect(loaded["ordinary/photo.jpg"]).toEqual(source["ordinary/photo.jpg"]);
  });
});
