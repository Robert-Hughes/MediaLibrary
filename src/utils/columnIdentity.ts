import type { SortKey, VisibleColumn } from "../types";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";

export function visibleColumnToken(column: VisibleColumn): string {
  return column.kind === "os" ? column.key : schemaDefinitionIdToken(column.id);
}

export function sortKeyMatchesColumn(
  sort: SortKey,
  column: VisibleColumn,
): boolean {
  if (sort.kind !== column.kind) return false;
  if (sort.kind === "os" && column.kind === "os")
    return sort.key === column.key;
  return (
    sort.kind === "image" &&
    column.kind === "image" &&
    schemaDefinitionIdEquals(sort.id, column.id)
  );
}
