import type {
  MetadataOccurrenceId,
  MetadataWriteTarget,
  SchemaDefinitionId,
} from "../types";

export function family7GroupFromRuntimeTagId(
  runtimeTagId: MetadataOccurrenceId["runtime_tag_id"],
): string {
  return `ID-${runtimeTagId}`;
}

export function family7GroupFromSchemaId(id: SchemaDefinitionId): string {
  const encoded = Array.from(new TextEncoder().encode(id.tag_id), (byte) => {
    const isAsciiAlphaNumeric =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a);
    return isAsciiAlphaNumeric || byte === 0x2d || byte === 0x5f
      ? String.fromCharCode(byte)
      : byte.toString(16).padStart(2, "0");
  }).join("");
  return `ID-${encoded}`;
}

export function metadataWriteTargetToken(target: MetadataWriteTarget): string {
  return JSON.stringify([target.group1, target.group7, target.tag_name]);
}

export function metadataWriteTargetEquals(
  left: MetadataWriteTarget,
  right: MetadataWriteTarget,
): boolean {
  return (
    left.group1 === right.group1 &&
    left.group7 === right.group7 &&
    left.tag_name === right.tag_name
  );
}

export function metadataWriteSelector(target: MetadataWriteTarget): string {
  return `1${target.group1}:7${target.group7}:${target.tag_name}`;
}

export function validateFamily1Group(group1: string): string | null {
  if (group1.length === 0) return "Destination group is required.";
  if (group1.trim() !== group1) {
    return "Destination group must not have leading or trailing whitespace.";
  }
  if (!/^[A-Za-z_#]/.test(group1)) {
    return "Destination group must begin with an ASCII letter, underscore, or #; do not enter a numeric family prefix such as 1IFD0.";
  }
  if (!/^[A-Za-z_#][A-Za-z0-9_#-]*$/.test(group1)) {
    return "Destination group may contain only ASCII letters, digits, underscore, #, and hyphen.";
  }
  return null;
}
