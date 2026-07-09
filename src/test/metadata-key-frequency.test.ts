// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ImageMetadataStore } from "../types";
import type { MetadataDraftEditsByFile, MetadataDraftEdit } from "../types";
import { computeEffectiveMetadataKeyFrequency } from "../utils/metadataKeyFrequency";
import { makePhotos, mockMetadata } from "./factories";

const setDraft = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: { kind: "Text", value },
});

const deleteDraft = (): MetadataDraftEdit => ({
  intent: "Delete",
  value: null,
});

function storeWith(paths: string[]) {
  const store = new ImageMetadataStore();
  for (const path of paths) {
    store.add(path);
  }
  return store;
}

function countEntries(
  paths: string[],
  setup: (
    store: ImageMetadataStore,
    draftEdits: MetadataDraftEditsByFile,
  ) => void,
) {
  const store = storeWith(paths);
  const draftEdits: MetadataDraftEditsByFile = {};
  setup(store, draftEdits);
  return computeEffectiveMetadataKeyFrequency(
    makePhotos(paths),
    store,
    draftEdits,
  );
}

describe("computeEffectiveMetadataKeyFrequency", () => {
  it("counts committed metadata keys across loaded files", () => {
    const counts = countEntries(["a.jpg", "b.jpg"], (store) => {
      store.set("a.jpg", mockMetadata({ "IFD0:Model": "Canon" }));
      store.set(
        "b.jpg",
        mockMetadata({ "IFD0:Model": "Nikon", "XMP-dc:Title": "Two" }),
      );
    });

    expect(counts.get("IFD0:Model")).toBe(2);
    expect(counts.get("XMP-dc:Title")).toBe(1);
  });

  it("counts draft-only keys", () => {
    const counts = countEntries(["a.jpg"], (store, drafts) => {
      store.set("a.jpg", mockMetadata({ "IFD0:Model": "Canon" }));
      drafts["a.jpg"] = { "XMP-dc:Title": setDraft("Draft title") };
    });

    expect(counts.get("XMP-dc:Title")).toBe(1);
  });

  it("counts committed and draft copies of the same key once per file", () => {
    const counts = countEntries(["a.jpg"], (store, drafts) => {
      store.set("a.jpg", mockMetadata({ "XMP-dc:Title": "Old title" }));
      drafts["a.jpg"] = { "XMP-dc:Title": setDraft("New title") };
    });

    expect(counts.get("XMP-dc:Title")).toBe(1);
  });

  it("combines committed keys on one file with draft-only keys on another", () => {
    const counts = countEntries(["a.jpg", "b.jpg"], (store, drafts) => {
      store.set("a.jpg", mockMetadata({ "XMP-dc:Title": "Committed" }));
      store.set("b.jpg", mockMetadata({}));
      drafts["b.jpg"] = { "XMP-dc:Title": setDraft("Draft") };
    });

    expect(counts.get("XMP-dc:Title")).toBe(2);
  });

  it("counts pending delete drafts as relevant keys", () => {
    const counts = countEntries(["a.jpg"], (store, drafts) => {
      store.set("a.jpg", mockMetadata({}));
      drafts["a.jpg"] = { "XMP-dc:Title": deleteDraft() };
    });

    expect(counts.get("XMP-dc:Title")).toBe(1);
  });

  it("counts draft keys while committed metadata is still loading", () => {
    const counts = countEntries(["a.jpg"], (_store, drafts) => {
      drafts["a.jpg"] = { "XMP-dc:Title": setDraft("Draft") };
    });

    expect(counts.get("XMP-dc:Title")).toBe(1);
  });

  it("ignores stale drafts for files outside the current photo list", () => {
    const counts = countEntries(["a.jpg"], (store, drafts) => {
      store.set("a.jpg", mockMetadata({}));
      drafts["not-in-current-list.jpg"] = {
        "XMP-dc:Title": setDraft("Stale"),
      };
    });

    expect(counts.has("XMP-dc:Title")).toBe(false);
  });

  it("reflects metadata that is set again after apply fresh-metadata events", () => {
    const counts = countEntries(["a.jpg", "b.jpg"], (store) => {
      store.set("a.jpg", mockMetadata({ "XMP-dc:Title": "One" }));
      store.set("b.jpg", mockMetadata({}));
      store.set("b.jpg", mockMetadata({ "XMP-dc:Title": "Two" }));
    });

    expect(counts.get("XMP-dc:Title")).toBe(2);
  });
});
