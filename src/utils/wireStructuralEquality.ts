/**
 * Exact structural equality for already-validated wire/domain values.
 *
 * Object key order and prototypes are ignored. An own property whose value is
 * `undefined` is treated as absent, matching optional generated TypeScript
 * fields. Cyclic inputs are rejected as unequal.
 */
export function wireStructuralEqual(left: unknown, right: unknown): boolean {
  return equalValue(left, right, new WeakSet<object>(), new WeakSet<object>());
}

function equalValue(
  left: unknown,
  right: unknown,
  leftAncestors: WeakSet<object>,
  rightAncestors: WeakSet<object>,
): boolean {
  if (typeof left !== "object" || left === null) return left === right;
  if (typeof right !== "object" || right === null) return false;

  if (leftAncestors.has(left) || rightAncestors.has(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;

  leftAncestors.add(left);
  rightAncestors.add(right);
  try {
    if (Array.isArray(left)) {
      const rightArray = right as unknown[];
      if (left.length !== rightArray.length) return false;
      return left.every((value, index) =>
        equalValue(value, rightArray[index], leftAncestors, rightAncestors),
      );
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter(
      (key) => leftRecord[key] !== undefined,
    );
    const rightKeys = Object.keys(rightRecord).filter(
      (key) => rightRecord[key] !== undefined,
    );
    if (leftKeys.length !== rightKeys.length) return false;

    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        rightRecord[key] !== undefined &&
        equalValue(
          leftRecord[key],
          rightRecord[key],
          leftAncestors,
          rightAncestors,
        ),
    );
  } finally {
    leftAncestors.delete(left);
    rightAncestors.delete(right);
  }
}
