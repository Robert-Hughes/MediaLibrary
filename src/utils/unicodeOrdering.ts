/**
 * Compares valid JavaScript strings by Unicode scalar value, matching Rust's
 * lexicographic `str` ordering without relying on locale or UTF-16 code units.
 */
export function compareUnicodeScalarStrings(
  left: string,
  right: string,
): number {
  const leftCodePoints = left[Symbol.iterator]();
  const rightCodePoints = right[Symbol.iterator]();

  while (true) {
    const leftNext = leftCodePoints.next();
    const rightNext = rightCodePoints.next();
    if (leftNext.done || rightNext.done) {
      return leftNext.done === rightNext.done ? 0 : leftNext.done ? -1 : 1;
    }

    const leftCodePoint = leftNext.value.codePointAt(0)!;
    const rightCodePoint = rightNext.value.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
}
