import { describe, expect, it, vi } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  type TargetDraftEditsByFile,
} from "../targetDraftEdits";
import {
  loadTargetDraftEdits,
  saveTargetDraftRows,
  targetDraftChangesToMutations,
  type TargetDraftTauriApi,
} from "../targetDraftTauri";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const schema = (table = "Exif::Main", tagId = "282"): SchemaDefinitionId => ({
  table,
  tag_id: tagId,
});

const saveTargetDraftEdits = (
  api: TargetDraftTauriApi,
  folderPath: string,
  source: TargetDraftEditsByFile,
) =>
  saveTargetDraftRows(
    api,
    folderPath,
    targetDraftChangesToMutations(
      Object.entries(source).map(([path, edits]) => ({ path, edits })),
    ),
  );

const existing = (
  path = "JPEG-APP1-IFD0",
  group1 = "IFD0",
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> => ({
  kind: "ExistingOccurrence",
  occurrence_id: {
    document: "Doc1",
    path,
    runtime_tag_id: "282",
    tag_id_scope: { table: "Exif::Main", tag_id: "282", index: null },
    copy: 2,
  },
  schema_id: schema(),
  write_target: { group1, group7: "ID-282", tag_name: "XResolution" },
});

const created = (
  id = schema(),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> => ({
  kind: "NewProperty",
  schema_id: id,
  write_target: { group1: "XMP-test", group7: "ID-Test", tag_name: "TestTag" },
});

const setEdit = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: { kind: "Text", value },
});

const entry = (
  target: MetadataDraftTarget,
  value = "value",
): MetadataTargetDraftEntry => ({ target, edit: setEdit(value) });

const drafts = (
  wire: Record<string, MetadataTargetDraftEntry[]>,
): TargetDraftEditsByFile => targetDraftsFromWire(wire);

describe("loadTargetDraftEdits", () => {
  it("uses the exact command and camel-case folder argument", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    await loadTargetDraftEdits({ invoke }, "C:/files");
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("load_metadata_draft_edits", {
      folderPath: "C:/files",
    });
  });

  it("strictly loads unknown payloads while preserving complete targets", async () => {
    const oldTarget = existing();
    const newTarget = created(schema("XMP::Main", "title"));
    const invoke = vi
      .fn()
      .mockResolvedValue({ "file.jpg": [entry(oldTarget), entry(newTarget)] });

    const loaded = await loadTargetDraftEdits({ invoke }, "folder");

    expect(
      loaded["file.jpg"][metadataDraftTargetSlotToken(oldTarget)].target,
    ).toEqual(oldTarget);
    expect(
      loaded["file.jpg"][metadataDraftTargetSlotToken(newTarget)].target,
    ).toEqual(newTarget);
  });

  it("loads a JSON-parsed __proto__ path as ordinary backend data", async () => {
    const target = created();
    const payload = JSON.parse(
      JSON.stringify(Object.fromEntries([["__proto__", [entry(target)]]])),
    );
    const loaded = await loadTargetDraftEdits(
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
      loadTargetDraftEdits(
        { invoke: vi.fn().mockResolvedValue({ "bad.jpg": [{}] }) },
        "folder",
      ),
    ).rejects.toThrow(/bad\.jpg.*array index 0/);

    const target = existing();
    await expect(
      loadTargetDraftEdits(
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
    const promise = loadTargetDraftEdits(
      { invoke: vi.fn().mockRejectedValue(rejection) },
      "folder",
    );
    await expect(promise).rejects.toBe(rejection);
  });
});

describe("saveTargetDraftRows", () => {
  it("uses the exact row-mutation command and arguments", async () => {
    const oldB = existing("IFD1", "IFD1");
    const oldA = existing("IFD0", "IFD0");
    const newB = created(schema("B", "tag"));
    const invoke = vi.fn().mockResolvedValue(undefined);
    const source = drafts({
      "z.jpg": [entry(newB), entry(oldB), entry(oldA)],
      "a.jpg": [entry(newB)],
    });
    const before = structuredClone(source);

    await saveTargetDraftEdits({ invoke }, "C:/files", source);

    expect(invoke).toHaveBeenCalledOnce();
    const [command, args] = invoke.mock.calls[0] as [
      string,
      {
        folderPath: string;
        mutations: Array<{
          relative_path: string;
          entries: MetadataTargetDraftEntry[];
        }>;
      },
    ];
    expect(command).toBe("save_metadata_draft_rows");
    expect(args.folderPath).toBe("C:/files");
    expect(args.mutations.map(({ relative_path }) => relative_path)).toEqual([
      "z.jpg",
      "a.jpg",
    ]);
    expect(args.mutations[0].entries.map(({ target }) => target)).toEqual([
      newB,
      oldB,
      oldA,
    ]);
    expect(
      args.mutations[0].entries.every(
        (wireEntry) =>
          Object.keys(wireEntry).sort().join(",") === "edit,target" &&
          !("slot" in wireEntry) &&
          !("slot_token" in wireEntry),
      ),
    ).toBe(true);
    expect(source).toEqual(before);
  });

  it("passes __proto__ as an ordinary row path", async () => {
    const target = created();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const source = drafts(
      Object.fromEntries([["__proto__", [entry(target, "reserved")]]]),
    );

    await saveTargetDraftEdits({ invoke }, "folder", source);

    const args = invoke.mock.calls[0][1] as {
      mutations: Array<{
        relative_path: string;
        entries: MetadataTargetDraftEntry[];
      }>;
    };
    expect(args.mutations).toEqual([
      { relative_path: "__proto__", entries: [entry(target, "reserved")] },
    ]);
  });

  it("rejects malformed changed rows before invoke", () => {
    expect(() =>
      targetDraftChangesToMutations([
        { path: "file.jpg", edits: { wrong: entry(existing()) } },
      ]),
    ).toThrow(/supplied record key 'wrong'/);
  });

  it("rejects duplicate malformed changed rows before invoke", () => {
    const first = entry(existing());
    const second = entry(structuredClone(first.target));
    expect(() =>
      targetDraftChangesToMutations([
        { path: "file.jpg", edits: { first, second } },
      ]),
    ).toThrow(/duplicate target/i);
  });

  it("propagates backend rejection unchanged", async () => {
    const rejection = new Error("backend save failed");
    const promise = saveTargetDraftEdits(
      { invoke: vi.fn().mockRejectedValue(rejection) },
      "folder",
      drafts({ "file.jpg": [entry(existing())] }),
    );
    await expect(promise).rejects.toBe(rejection);
  });
});

describe("target draft frontend/Tauri contract round-trip", () => {
  it("round-trips mixed logical slots through a JSON-cloned fake backend", async () => {
    let wireSnapshot: unknown = {};
    const api: TargetDraftTauriApi = {
      async invoke(command, args) {
        if (command === "save_metadata_draft_rows") {
          wireSnapshot = Object.fromEntries(
            (
              args?.mutations as Array<{
                relative_path: string;
                entries: MetadataTargetDraftEntry[];
              }>
            ).map(({ relative_path, entries }) => [relative_path, entries]),
          );
          return undefined;
        }
        if (command === "load_metadata_draft_edits") {
          return JSON.parse(JSON.stringify(wireSnapshot));
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const ifd0 = existing("JPEG-APP1-IFD0", "IFD0");
    const ifd1 = existing("JPEG-APP1-IFD1", "IFD1");
    const newTarget = created(ifd0.schema_id);
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("file.jpg", ifd0, setEdit("ifd0"));
    store.setMetadataTarget("file.jpg", ifd1, setEdit("ifd1"));
    store.setMetadataTarget("file.jpg", newTarget, setEdit("new"));

    const changedSnapshot = {
      ...ifd0,
      schema_id: schema("Changed::Schema", "999"),
      write_target: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "ChangedName",
      },
    };
    store.setMetadataTarget("file.jpg", changedSnapshot, setEdit("changed"));
    const source = store.getAllMetadata();

    await saveTargetDraftEdits(api, "folder", source);
    const loaded = await loadTargetDraftEdits(api, "folder");

    expect(loaded).toEqual(source);
    expect(Object.keys(loaded["file.jpg"])).toHaveLength(3);
    expect(
      loaded["file.jpg"][metadataDraftTargetSlotToken(ifd0)].target,
    ).toEqual(changedSnapshot);
    expect(
      loaded["file.jpg"][metadataDraftTargetSlotToken(ifd1)].target,
    ).toEqual(ifd1);
    expect(
      loaded["file.jpg"][metadataDraftTargetSlotToken(newTarget)].target,
    ).toEqual(newTarget);
  });

  it("keeps __proto__ separate from an ordinary path through JSON cloning", async () => {
    let wireSnapshot: unknown = {};
    const api: TargetDraftTauriApi = {
      async invoke(command, args) {
        if (command === "save_metadata_draft_rows") {
          wireSnapshot = Object.fromEntries(
            (
              args?.mutations as Array<{
                relative_path: string;
                entries: MetadataTargetDraftEntry[];
              }>
            ).map(({ relative_path, entries }) => [relative_path, entries]),
          );
          return undefined;
        }
        if (command === "load_metadata_draft_edits") {
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
        ["ordinary/file.jpg", [ordinary]],
      ]),
    );

    await saveTargetDraftEdits(api, "folder", source);
    const loaded = await loadTargetDraftEdits(api, "folder");

    expect(Object.keys(loaded)).toEqual(["__proto__", "ordinary/file.jpg"]);
    expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(
      true,
    );
    expect(loaded.__proto__).toEqual(source.__proto__);
    expect(loaded["ordinary/file.jpg"]).toEqual(source["ordinary/file.jpg"]);
  });
});
