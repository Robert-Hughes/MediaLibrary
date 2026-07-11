import { PhotoList as ExactPhotoList } from "../components/PhotoList";
import { GalleryView as ExactGalleryView } from "../components/GalleryView";
import { DetailsPane as ExactDetailsPane } from "../components/DetailsPane";
import { TypedValueEditor as ExactTypedValueEditor } from "../components/editors/TypedValueEditor";
import { ColumnSelectionDialog as ExactColumnSelectionDialog } from "../components/ColumnSelectionDialog";
import { NewPropertyDialog as ExactNewPropertyDialog } from "../components/NewPropertyDialog";
import { GpsEditor as ExactGpsEditor } from "../components/editors/GpsEditor";
import {
  _ensureTagInfoCacheEntry,
  _setTagInfoCacheEntry,
} from "../hooks/useTagInfo";
import {
  mockDrafts,
  mockDraftsByFile,
  mockMetadata,
  osCol,
  testFriendlyName,
  testId,
} from "./factories";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const ensureLabel = (key: string) => {
  const id = testId(key);
  const colon = key.indexOf(":");
  _ensureTagInfoCacheEntry(id, {
    group: colon > 0 ? key.slice(0, colon) : "Other",
    name: colon > 0 ? key.slice(colon + 1) : key,
    writable: true,
    kind: { kind: "Text" },
    description: null,
    storage_count: undefined,
  });
  return id;
};

const ensureColumnLabel = (key: string) => {
  const id = testId(key);
  const colon = key.indexOf(":");
  _ensureTagInfoCacheEntry(id, {
    group: colon > 0 ? key.slice(0, colon) : "Other",
    name: colon > 0 ? key.slice(colon + 1) : key,
    writable: true,
    kind: { kind: "Text" },
    description: null,
    storage_count: undefined,
  });
  return id;
};

const columns = (values: any[] = []) =>
  values.map((column) =>
    column.kind === "image" && "key" in column
      ? { kind: "image", id: ensureColumnLabel(column.key) }
      : column.kind === "os"
        ? osCol(column.key)
        : column,
  );

const displayDrafts = (raw: Record<string, string | null> | undefined) =>
  raw &&
  Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      schemaDefinitionIdToken(testId(key)),
      value,
    ]),
  );

export const sort = (value: any) => {
  if (!value || "kind" in value) return value;
  if (value.columnType === "path")
    return { kind: "path", direction: value.direction };
  if (value.columnType === "os")
    return { kind: "os", key: value.column, direction: value.direction };
  return {
    kind: "image",
    id: testId(value.column),
    direction: value.direction,
  };
};

export const legacySort = (value: any) =>
  !value
    ? value
    : value.kind === "path"
      ? {
          column: "relative_path",
          columnType: "path",
          direction: value.direction,
        }
      : value.kind === "os"
        ? { column: value.key, columnType: "os", direction: value.direction }
        : {
            column: testFriendlyName(value.id),
            columnType: "image",
            direction: value.direction,
          };

export const exactSortConfig = (config: any) => ({
  primary: sort(config?.primary),
  secondary: sort(config?.secondary),
});
export const legacySortConfig = (config: any) => ({
  primary: legacySort(config?.primary),
  secondary: legacySort(config?.secondary),
});

export function PhotoList(props: any) {
  return (
    <ExactPhotoList
      {...props}
      visibleColumns={columns(props.visibleColumns)}
      sortConfig={{
        primary: sort(props.sortConfig?.primary),
        secondary: sort(props.sortConfig?.secondary),
      }}
      draftEdits={
        props.draftEdits ? mockDraftsByFile(props.draftEdits) : undefined
      }
      onSortChange={(config) =>
        props.onSortChange?.({
          primary: legacySort(config.primary),
          secondary: legacySort(config.secondary),
        })
      }
      onColumnsReorder={
        props.onColumnsReorder
          ? (next) =>
              props.onColumnsReorder(
                next.map((column) =>
                  column.kind === "os"
                    ? column
                    : { kind: "image", key: testFriendlyName(column.id) },
                ),
              )
          : undefined
      }
      onRemoveFieldFromSelectedPhotos={
        props.onRemoveFieldFromSelectedPhotos
          ? (id, paths) =>
              props.onRemoveFieldFromSelectedPhotos(testFriendlyName(id), paths)
          : undefined
      }
    />
  );
}

export function TypedValueEditor(props: any) {
  const { propertyKey, metadataForFile, ...rest } = props;
  return (
    <ExactTypedValueEditor
      {...rest}
      propertyId={testId(propertyKey)}
      propertyLabel={propertyKey}
      metadataForFile={
        metadataForFile ? mockMetadata(metadataForFile) : undefined
      }
    />
  );
}

export function DetailsPane(props: any) {
  const metadata =
    props.metadata === "loading"
      ? "loading"
      : Object.values(props.metadata ?? {}).every((value: any) => value?.id)
        ? props.metadata
        : mockMetadata(props.metadata ?? {});
  if (metadata !== "loading") {
    for (const value of Object.values(metadata) as any[])
      ensureLabel(testFriendlyName(value.id));
  }
  for (const key of Object.keys(props.typedDraftEdits ?? {})) ensureLabel(key);
  return (
    <ExactDetailsPane
      {...props}
      metadata={metadata}
      draftEdits={displayDrafts(props.draftEdits)}
      typedDraftEdits={
        props.typedDraftEdits ? mockDrafts(props.typedDraftEdits) : undefined
      }
      onSetMetadataDraft={(id, edit) =>
        props.onSetMetadataDraft?.(testFriendlyName(id), edit)
      }
      onSetMetadataDraftBatch={(entries) =>
        props.onSetMetadataDraftBatch?.(
          entries.map(({ id, edit }) => ({ key: testFriendlyName(id), edit })),
        )
      }
      onDiscardDraft={(id) => props.onDiscardDraft?.(testFriendlyName(id))}
      onDiscardDraftBatch={(ids) =>
        props.onDiscardDraftBatch?.(ids.map(testFriendlyName))
      }
    />
  );
}

export function GalleryView(props: any) {
  for (const key of Object.keys(props.typedDraftEdits ?? {})) ensureLabel(key);
  return (
    <ExactGalleryView
      {...props}
      draftEdits={displayDrafts(props.draftEdits)}
      typedDraftEdits={
        props.typedDraftEdits ? mockDrafts(props.typedDraftEdits) : undefined
      }
      onSetMetadataDraft={(path, id, edit) =>
        props.onSetMetadataDraft?.(path, testFriendlyName(id), edit)
      }
      onSetMetadataDraftBatch={(path, entries) =>
        props.onSetMetadataDraftBatch?.(
          path,
          entries.map(({ id, edit }) => ({ key: testFriendlyName(id), edit })),
        )
      }
      onDiscardDraft={(path, id) =>
        props.onDiscardDraft?.(path, testFriendlyName(id))
      }
      onDiscardDraftBatch={(path, ids) =>
        props.onDiscardDraftBatch?.(path, ids.map(testFriendlyName))
      }
    />
  );
}

export function ColumnSelectionDialog(props: any) {
  const allKeys = props.allKeys.map(({ key, count }: any) => {
    const id = testId(key);
    const colon = key.indexOf(":");
    _setTagInfoCacheEntry(id, {
      group: colon > 0 ? key.slice(0, colon) : "Test",
      name: colon > 0 ? key.slice(colon + 1) : key,
      writable: true,
      kind: { kind: "Text" },
      description: null,
      storage_count: undefined,
    });
    return { id, count };
  });
  return (
    <ExactColumnSelectionDialog
      {...props}
      allKeys={allKeys}
      visibleColumns={columns(props.visibleColumns)}
      onSave={(next, reset) =>
        props.onSave(
          next.map((column) =>
            column.kind === "os"
              ? column
              : { kind: "image", key: testFriendlyName(column.id) },
          ),
          reset,
        )
      }
    />
  );
}

export function NewPropertyDialog(props: any) {
  const { existingKeys, ...rest } = props;
  return (
    <ExactNewPropertyDialog
      {...rest}
      existingIds={existingKeys ? [...existingKeys].map(testId) : undefined}
      onSave={(id) => props.onSave(testFriendlyName(id))}
    />
  );
}

export function GpsEditor(props: any) {
  const group = {
    latitudeId: testId(props.group.latitudeKey),
    latitudeRefId: testId(props.group.latitudeRefKey),
    longitudeId: testId(props.group.longitudeKey),
    longitudeRefId: testId(props.group.longitudeRefKey),
    altitudeId: testId(props.group.altitudeKey),
    altitudeRefId: testId(props.group.altitudeRefKey),
  };
  return (
    <ExactGpsEditor
      {...props}
      group={group}
      onSave={(entries) =>
        props.onSave(
          entries.map(({ id, edit }) => ({ key: testFriendlyName(id), edit })),
        )
      }
    />
  );
}
