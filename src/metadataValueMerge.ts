import type { MetadataValue, TagKind } from "./types";
import { metadataValueEqual } from "./types";

export type MetadataValueMergeResult =
  | { kind: "merged"; value: MetadataValue }
  | { kind: "unsupported"; reason: string };

function listItems(value: MetadataValue | undefined): MetadataValue[] | null {
  if (value === undefined) return [];
  if (value.kind === "List") return value.value.items;
  return [value];
}

/**
 * Merge a user-entered semantic patch into one file's current effective value.
 * This is intentionally pure because preview and final staging must use the
 * identical rules.
 */
export function mergeMetadataValueExactly(
  schemaKind: TagKind,
  current: MetadataValue | undefined,
  patch: MetadataValue,
): MetadataValueMergeResult {
  if (
    schemaKind.kind === "Bag" ||
    schemaKind.kind === "Seq" ||
    schemaKind.kind === "Alt"
  ) {
    if (patch.kind !== "List") {
      return {
        kind: "unsupported",
        reason: "The collection editor did not return a list value.",
      };
    }
    if (current?.kind === "Unknown" || current?.kind === "Binary") {
      return {
        kind: "unsupported",
        reason: "The existing collection value cannot be interpreted safely.",
      };
    }
    const existing = listItems(current);
    if (existing === null) {
      return {
        kind: "unsupported",
        reason: "The existing collection value cannot be interpreted safely.",
      };
    }
    const items = existing.map((item) => structuredClone(item));
    for (const candidate of patch.value.items) {
      if (!items.some((item) => metadataValueEqual(item, candidate))) {
        items.push(structuredClone(candidate));
      }
    }
    return {
      kind: "merged",
      value: {
        kind: "List",
        value: { list_kind: schemaKind.kind, items },
      },
    };
  }

  if (schemaKind.kind === "LangAlt") {
    if (patch.kind !== "LangAlt") {
      return {
        kind: "unsupported",
        reason:
          "The language-alternative editor returned an incompatible value.",
      };
    }
    if (current !== undefined && current.kind !== "LangAlt") {
      return {
        kind: "unsupported",
        reason: "The existing value is not a language-alternative map.",
      };
    }
    return {
      kind: "merged",
      value: {
        kind: "LangAlt",
        value: {
          ...(current?.kind === "LangAlt"
            ? structuredClone(current.value)
            : {}),
          ...structuredClone(patch.value),
        },
      },
    };
  }

  if (schemaKind.kind === "Text") {
    if (patch.kind !== "Text") {
      return {
        kind: "unsupported",
        reason: "The text editor did not return a text value.",
      };
    }
    if (current !== undefined && current.kind !== "Text") {
      return {
        kind: "unsupported",
        reason: "The existing value is not a text value.",
      };
    }
    const existingText = current?.value ?? "";
    return {
      kind: "merged",
      value: {
        kind: "Text",
        value: existingText + patch.value,
      },
    };
  }

  return {
    kind: "unsupported",
    reason: `Merge is not supported for ${schemaKind.kind} metadata.`,
  };
}
