# Design Document: Frontend Performance Fix for Large Folder Loading

## Overview

This design addresses the performance issue where the frontend becomes overloaded when loading metadata for large folders. The root cause is excessive React state updates triggered by individual metadata events arriving rapidly.

## Technical Analysis

### Root Cause

The current implementation has these issues:

1. **Separate setTimeout per metadata event**: Each `image_metadata_ready` event creates its own setTimeout, calling `flushBatch()` independently
2. **Full state rebuild on each flush**: `flushBatch()` rebuilds the entire `photos` array and sets a new `imageMetadataRemaining` value, triggering cascading re-renders
3. **No metadata event batching**: Unlike `photo_found` events which have proper batching, metadata events have no batching mechanism
4. **No virtualization**: PhotoList renders all rows immediately, causing DOM overload with large folders

## Proposed Solution

### 1. Metadata Event Batching

Add a buffer for metadata events similar to the photo_found batching:

```typescript
// Add to existing refs
const metadataBufferRef = useRef<{ relative_path: string; metadata: Record<string, Variant> }[]>([]);
const metadataBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const isFirstMetadataFlushRef = useRef<boolean>(true);
```

Modify the `image_metadata_ready` listener to batch events:

```typescript
const unlistenMetadata = await api.listen("image_metadata_ready", (raw) => {
  const { scan_id, results } = raw as ImageMetadataReadyPayload;
  if (scan_id !== activeScanIdRef.current) return;
  
  // Buffer metadata instead of processing immediately
  metadataBufferRef.current.push(...results);
  
  const shouldFlushNow = isFirstMetadataFlushRef.current || 
                         metadataBufferRef.current.length >= 50;
  
  if (shouldFlushNow) {
    isFirstMetadataFlushRef.current = false;
    flushMetadataBatch();
  } else if (!metadataBatchTimerRef.current) {
    metadataBatchTimerRef.current = setTimeout(() => {
      metadataBatchTimerRef.current = null;
      flushMetadataBatch();
    }, 200); // Longer interval for metadata to reduce updates
  }
});
```

### 2. Optimized flushMetadataBatch Function

```typescript
const flushMetadataBatch = () => {
  const batch = [...metadataBufferRef.current];
  metadataBufferRef.current = [];
  
  for (const res of batch) {
    imageMetadataStoreRef.current.set(res.relative_path, res.metadata);
    imageMetadataReceivedRef.current += 1;
  }
  
  // Only update state if scanning
  setAppState((prev) => {
    if (prev.kind !== "loaded") return prev;
    
    const newRemaining = Math.max(0, prev.photos.length - imageMetadataReceivedRef.current);
    
    // Skip update if remaining count unchanged
    if (prev.imageMetadataRemaining === newRemaining && batch.length > 0) {
      return prev;
    }
    
    return {
      ...prev,
      imageMetadataRemaining: newRemaining,
    };
  });
};
```

### 3. Proper Cleanup on Scan Complete/Stop

```typescript
// In startScan - reset metadata buffers
metadataBufferRef.current = [];
isFirstMetadataFlushRef.current = true;
if (metadataBatchTimerRef.current) {
  clearTimeout(metadataBatchTimerRef.current);
  metadataBatchTimerRef.current = null;
}

// In scan_complete listener
if (metadataBatchTimerRef.current) {
  clearTimeout(metadataBatchTimerRef.current);
  metadataBatchTimerRef.current = null;
}
flushMetadataBatch();
```

## File Changes

### Modified Files

1. **src/useMediaLibrary.ts**
   - Add metadata buffer refs
   - Modify image_metadata_ready listener for batching
   - Add flushMetadataBatch function
   - Add cleanup on scan start/complete

2. **src/components/PhotoList.tsx** (optional future enhancement)
   - Consider adding virtualization with react-window for very large lists
   - Current implementation uses useSyncExternalStore correctly for row-level updates

## Testing

1. Create a test folder with 1000+ photos
2. Measure time from scan start to all metadata displayed
3. Verify spinners disappear correctly as metadata loads
4. Verify UI remains responsive during loading

## Trade-offs

- Metadata updates will have a slight delay (200ms) due to batching, but overall UI will be more responsive
- ImageMetadataRemaining counter may not update as frequently, but this is acceptable as it's informational only
- For very large folders (10,000+ photos), virtualization would be needed as a follow-up

## Related

- react-window for virtualization: https://github.com/bvaughn/react-window
- React performance with large lists: Virtualization is the recommended approach for 1000+ items