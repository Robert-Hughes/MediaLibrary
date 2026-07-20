export interface FlashFields {
  fired: boolean;
  returnStatus: 0 | 2 | 3;
  mode: 0 | 1 | 2 | 3;
  noFunction: boolean;
  redEye: boolean;
}

export function decodeFlashCode(code: number): FlashFields {
  return {
    fired: (code & 0b1) !== 0,
    returnStatus: ((code >> 1) & 0b11) as 0 | 2 | 3,
    mode: ((code >> 3) & 0b11) as 0 | 1 | 2 | 3,
    noFunction: (code & 0b100000) !== 0,
    redEye: (code & 0b1000000) !== 0,
  };
}

export function encodeFlashFields(fields: FlashFields): number {
  return (
    (fields.fired ? 1 : 0) |
    ((fields.returnStatus & 0b11) << 1) |
    ((fields.mode & 0b11) << 3) |
    (fields.noFunction ? 0b100000 : 0) |
    (fields.redEye ? 0b1000000 : 0)
  );
}

export const MODE_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Compulsory firing",
  2: "Compulsory suppression",
  3: "Auto",
};

export const RETURN_LABELS: Record<number, string> = {
  0: "No return detected",
  2: "Return not detected",
  3: "Return detected",
};

export function describeFlashCode(fields: FlashFields): string {
  const parts: string[] = [];
  if (fields.noFunction) {
    parts.push("No flash function");
  } else {
    parts.push(fields.fired ? "Fired" : "Did not fire");
    if (fields.mode !== 0) parts.push(MODE_LABELS[fields.mode]);
    if (fields.returnStatus !== 0)
      parts.push(RETURN_LABELS[fields.returnStatus]);
    if (fields.redEye) parts.push("Red-eye reduction");
  }
  return parts.join(", ");
}
