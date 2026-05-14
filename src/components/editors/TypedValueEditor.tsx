// Schema-aware editor router (Phase 4 MVP).
//
// Picks an editor component based on the tag's TagKind:
//
// - Bag<Text>   → BagEditor (chip list; first concrete typed editor)
// - Seq<Text>   → BagEditor (with order preserved by typed-list save)
// - everything  → legacy ValueEditDialog (single text input)
//
// As more typed editors land (LangAlt, Enum, Integer, GPS, Flash, Struct),
// they get added as cases here.  The fallback to ValueEditDialog keeps the
// existing UI working for every tag we haven't migrated yet.

import { useTagInfo } from "../../hooks/useTagInfo";
import type { DraftEdit, TagKind, Variant } from "../../types";
import { ValueEditDialog } from "../ValueEditDialog";
import { BagEditor, initialItemsFrom } from "./BagEditor";
import { variantToDisplayString } from "../../draft";

interface Props {
  propertyKey: string;
  /** Current value as a Variant (from raw_metadata or display) or fall back to the legacy string. */
  initialVariant?: Variant;
  initialString: string;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
}

function isBagOrSeqOfText(kind: TagKind): boolean {
  if (kind.kind !== "Bag" && kind.kind !== "Seq") return false;
  const inner = kind.data;
  return inner.kind === "Text" || inner.kind === "Unknown";
}

export function TypedValueEditor({
  propertyKey,
  initialVariant,
  initialString,
  onSave,
  onCancel,
}: Props) {
  const tag = useTagInfo(propertyKey);

  if (tag === "loading") {
    // First-call lookup; schema build can take 100-500ms.  Show the legacy
    // text editor so the user isn't blocked.  Switching to a richer editor
    // mid-typing would lose input, so this is a one-render decision.
    return (
      <ValueEditDialog
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={(s) => onSave({ value: s, intent: "Set" })}
        onCancel={onCancel}
      />
    );
  }

  if (tag && isBagOrSeqOfText(tag.kind)) {
    const initialItems = initialItemsFrom(initialVariant ?? initialString);
    return (
      <BagEditor
        propertyKey={propertyKey}
        initialItems={initialItems}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // Fallback: legacy text input.
  return (
    <ValueEditDialog
      propertyKey={propertyKey}
      initialValue={initialString}
      onSave={(s) => onSave({ value: s, intent: "Set" })}
      onCancel={onCancel}
    />
  );
}

/** Pretty-print a Variant for the "initialString" prop fallback. */
export const fallbackString = variantToDisplayString;
