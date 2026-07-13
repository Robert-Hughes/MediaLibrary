export function hasOwnStringKey<T>(
  record: Record<string, T>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function recordFromEntries<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  return Object.fromEntries(entries);
}
