import type { TagInfo } from "../types";

/** Shared frontend equivalent of Rust's supported metadata write-kind rule. */
export function tagInfoSupportsMetadataWrite(info: TagInfo): boolean {
  return (
    info.writable && info.kind.kind !== "Binary" && info.kind.kind !== "Unknown"
  );
}
