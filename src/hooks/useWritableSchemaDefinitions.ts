import { useEffect, useMemo, useState } from "react";
import type { TagInfo } from "../types";
import {
  _setTagInfoForTests,
  allTagInfos,
  subscribeTagSchemaRegistry,
  tagSchemaRegistryIsInstalled,
} from "../tagSchemaRegistry";
import { tagInfoSupportsMetadataWrite } from "../utils/metadataWriteSupport";

type State = "loading" | TagInfo[];

let testOverride: TagInfo[] | null = null;

function withDefaultGroup0(info: TagInfo): TagInfo {
  if (info.group0 !== undefined) return info;
  const group0 = info.id.table.startsWith("XMP::")
    ? "XMP"
    : info.id.table.startsWith("IPTC::")
      ? "IPTC"
      : info.group.startsWith("XMP-")
        ? "XMP"
        : "EXIF";
  return { ...info, group0 };
}

/** Returns every exact supported writable definition from the startup registry. */
export function useWritableSchemaDefinitions(): State {
  const [generation, setGeneration] = useState(0);

  useEffect(
    () => subscribeTagSchemaRegistry(() => setGeneration((value) => value + 1)),
    [],
  );

  return useMemo(() => {
    // Registry notifications increment generation, invalidating this snapshot.
    void generation;
    if (testOverride !== null) {
      return testOverride.filter((info) =>
        tagInfoSupportsMetadataWrite(info, undefined, "DeleteExisting"),
      );
    }
    if (!tagSchemaRegistryIsInstalled()) return "loading";
    return allTagInfos().filter((info) =>
      tagInfoSupportsMetadataWrite(info, undefined, "DeleteExisting"),
    );
  }, [generation]);
}

// Test-only controls retained for existing component fixtures. The override is
// presentation-only; exact TagInfo still lives in the one frontend registry.
export function _resetWritableSchemaDefinitionsCache(): void {
  testOverride = null;
}

export function _setWritableSchemaDefinitionsCache(tags: TagInfo[]): void {
  testOverride = tags.map(withDefaultGroup0);
  for (const info of testOverride) {
    _setTagInfoForTests(info.id, info);
  }
}
