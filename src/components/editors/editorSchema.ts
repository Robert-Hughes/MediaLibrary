import type { TagKind } from "../../types";

export interface InheritedEditorSchema {
  kind: TagKind;
  readOnly: boolean;
  sourceLabel?: string;
}
