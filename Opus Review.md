I now have a thorough picture of the entire codebase. Let me write the review.

---

# Code Review

## 1. Race Conditions & Threading

### Critical: Old scan cleanup overwrites new scan's queues (`lib.rs:459–462`)

The outer spawn thread finishes in this order:

```rust
let _ = app_clone.emit("scan_complete", ...);
clear_running(&app_clone);          // ← running = false, new scan may start here
image_metadata_queue.finish();
thumb_queue.finish();
for h in metadata_handles { h.join(); }  // workers may take seconds to finish
for h in thumb_handles    { h.join(); }
// ← NEW SCAN has already installed its queues into active_queues by now
*thumbnails_arc.lock().unwrap() = None;      // ← OVERWRITES new scan's queue
*image_metadata_arc.lock().unwrap() = None;  // ← OVERWRITES new scan's queue
```

`thumbnails_arc` is a clone of the `Arc<Mutex<Option<Arc<WorkQueue>>>>` shared with `active_queues`. After `clear_running` unblocks a new `start_scan`, that new scan installs its fresh queues into `active_queues`. Then the old scan's cleanup unconditionally nils them out. The new scan's `prioritize_queues` calls then silently no-op because `active_queues.thumbnails` is `None`.

**Fix**: Remove the final `= None` cleanup block. The queues are already drained/aborted; their Arc refcounts will drop naturally when the workers finish. Or add a scan-generation counter and only clear if the stored queue still belongs to this scan.

### Bug: `scan_error` has no `scan_id` (`lib.rs:75–78`, `useMediaLibrary.ts:379–383`)

```rust
struct ScanErrorPayload { message: String }  // no scan_id
```

```ts
api.listen("scan_error", (raw) => {
    setAppState({ kind: "idle" });  // no scan_id guard
})
```

A stale error from a previous scan (e.g., "not a directory" for the old path) arrives during a new scan and resets the app to idle with no warning. Add `scan_id` to `ScanErrorPayload` and guard the handler the same way every other event is guarded.

### Minor: Spin-wait in `start_scan` blocks a Tauri thread (`lib.rs:167–180`)

```rust
while *running && attempts < 20 {
    drop(running);
    std::thread::sleep(std::time::Duration::from_millis(50));  // up to 1 second
    running = scan_state.running.lock().unwrap();
    attempts += 1;
}
```

This burns a blocking-thread-pool slot for up to a second. The existing `WorkQueue` already shows how to do this correctly with a `Condvar`. Add one to `ScanState`:

```rust
struct ScanState {
    running:   Mutex<bool>,
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
    cvar:      Condvar,
}
```

Then `clear_running` calls `state.cvar.notify_all()` and `start_scan` waits with `cvar.wait_timeout`.

### Minor: `clear_running` clears the cancellation flag before workers are done

`clear_running` sets `*state.cancelled.lock().unwrap() = None`. If `stop_scan` is called during the window between `clear_running` and workers finishing `join()`, it finds `None` and can't signal the old workers. The workers do have their own `cancel_clone` Arc, so they aren't broken, but `stop_scan` silently does less than expected.

---

## 2. Architecture & Data Flow

The overall architecture—three concurrent phases, observable stores outside React state, `useSyncExternalStore` per row, Tauri IPC events—is solid and well thought out. A few structural concerns:

### OS column header positions break after drag-reorder (`PhotoList.tsx:381–388`)

Headers for OS date columns use hardcoded `gridColumn` values:

```tsx
<div style={{ gridRow: 2, gridColumn: 3 }}>Modified…</div>
<div style={{ gridRow: 2, gridColumn: visibleOSColumns.includes("date_modified") ? 4 : 3 }}>Created…</div>
```

`buildGridTemplate` outputs columns in `visibleOSColumns` order, so after a drag-reorder (`["date_created", "date_modified"]`), the grid template puts `date_created` at column 3 and `date_modified` at column 4. But the headers still render `date_modified` at column 3 and `date_created` at column 4 — they're swapped. The row cells are rendered in document order matching the template, so body and header diverge.

Fix: replace the hardcoded positions with index-based computation from `visibleOSColumns`.

### ~200 lines of header JSX are duplicated (`PhotoList.tsx:362–395` vs `409–425`)

The empty-photos branch and the non-empty branch render identical header rows. Extract a shared `<PhotoListHeader>` sub-component.

### `gridColumns` string prop causes all visible rows to re-render on every resize drag (`PhotoList.tsx:116–118, 452`)

```ts
const effectiveWidths = Object.keys(liveWidths).length > 0
    ? { ...columnWidths, ...liveWidths }
    : columnWidths;
// recomputed on every setLiveWidths call (every pointer-move pixel)
const gridColumns = buildGridTemplate(..., effectiveWidths);
```

`gridColumns` changes on every `pointermove` → passed to every `PhotoRow` → all `memo()`-wrapped rows re-render. Set `--grid-columns` as a CSS custom property on the container's `style` instead, and have the row read it via `gridTemplateColumns: "var(--grid-columns)"`. No prop change, no memo invalidation.

### Subscriber Sets leak empty entries after unsubscription (`types.ts:47–51`, `107–111`)

```ts
subscribe(path: string, cb: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(cb);
    return () => this.subscribers.get(path)?.delete(cb);
    //           ^ never removes the Set from the Map even when empty
}
```

For 10 000 photos, this leaves 10 000 empty `Set` objects in `ThumbnailStore.subscribers` and `ImageMetadataStore.subscribers` after users scroll through them. One line in the unsubscribe closure fixes it: `if (this.subscribers.get(path)?.size === 0) this.subscribers.delete(path)`.

---

## 3. Performance

### O(N) full-list scan on every scroll in `notify()` (`PhotoList.tsx:139–156`)

```ts
const notify = () => {
    const visibleOrdered = photosRef.current          // ← full list, up to 10k
        .filter(p => visibleRef.current.has(p.relative_path))
        .filter(p => { /* store lookups */ })
        .map(p => p.relative_path);
```

`photosRef.current` is the full array. For 10k photos, this iterates 10k elements on every scroll event to find ~30 visible ones. Invert the loop: iterate `visibleRef.current` (the small set of visible paths) and look up store state for each. O(visible) instead of O(total).

### Initial prioritization fires on every photo batch (`PhotoList.tsx:181–201`)

```ts
useEffect(() => {
    if (photos.length > 0) { /* slice first 30 and call onVisibilityChange */ }
}, [photos.length, thumbnails, imageMetadata, onVisibilityChange]);
```

The comment says "only run when photos first load" but `photos.length` changes on every batch during a scan. For 10k photos batched at 50, this fires 200 times. The `virtualItems`-based effect already handles ongoing visibility, so this could run only once: `useEffect(..., [])` checking `photos.length > 0` on mount is sufficient.

### `sortPhotos` re-runs on every photo batch AND every metadata batch (`App.tsx:42–47`)

```tsx
const sortedPhotos = useMemo(
    () => sortPhotos(state.photos, state.sortConfig, state.imageMetadata),
    [state.photos, state.sortConfig, state.metadataVersion, state.imageMetadata],
);
```

Both `state.photos` (photo batches) and `state.metadataVersion` (metadata batches) invalidate this memo. For 10k photos sorted by an image metadata field at 50 items/batch: that's 200 re-sorts during photo discovery + 200 re-sorts during metadata loading = ~400 O(N log N) sorts with O(N) Map lookups per sort. Consider debouncing re-sorts during active scanning, or only triggering `metadataVersion` updates when the sorted column's data changes.

### `prioritize()` is O(N×M): builds a HashSet from the full queue (`work_queue.rs:128–151`)

For M visible paths and N total queued items, this is O(N + M) per call, which is fine. But it also doesn't hold the condvar lock for notification—correct. No issue here beyond the lock duration for large queues.

### Uncapped `workerErrors` array

```ts
return { ...prev, workerErrors: [...prev.workerErrors, payload] };
```

In a folder where ExifTool fails on many batches, this array grows without bound. Cap at ~20 with a "...and N more errors" display.

---

## 4. Error Handling

- **`scan_error` → idle with no guard** (covered above): a stale error nukes an active scan.
- **`serde_json::from_str(...).unwrap_or_default()`** (`scanner.rs:263`): invalid ExifTool JSON is silently replaced with an empty vec, making all files in that batch appear to have no metadata with no logged reason. Should log the parse error before falling back.
- **`scan_folder` swallows `WalkDir` errors** (`scanner.rs:123–126`): `Err(_) => continue`. Permission errors on subdirectories are ignored silently; there's no `worker_error` event for walk errors. A folder the user can't read should at least emit a warning.
- **`worker_error` events have no scan_id guard in Rust** — the scan_id is included in the payload and the frontend guards on it, so this is fine.
- **`closeFolder` doesn't flush or reset timers**: it sets `activeScanIdRef.current = -1` (preventing future events from being processed) but leaves `batchTimerRef.current` running. When the timer fires, `flushBatch` calls `setAppState((prev) => prev.kind === "idle" ? prev : ...)`, which is safe because idle is returned unchanged. Low severity but the timers should be cancelled.

---

## 5. Module Layout

| File | Lines | Assessment |
|---|---|---|
| `lib.rs` | 605 | Reasonable. Commands are cohesive. The `start_scan` function is long (300 lines) and could benefit from extracting the phase setup into named helpers. |
| `scanner.rs` | 544 | Fine. `extract_exif_thumbnail` could live in its own file. |
| `work_queue.rs` | 521 | Well-isolated; tests are inline and good. |
| `useMediaLibrary.ts` | 528 | Does too much. Flush logic, event listeners, store lifecycle, and all actions live here. The three flush functions (`flushBatch`, `flushMetadataBatch`, `flushThumbnailBatch`) are structurally identical and could be one parameterized function. |
| `PhotoList.tsx` | 585 | Fine overall. The duplicated headers and the inline resize/drag logic make the file dense. Splitting `PhotoRow` to its own file and `ResizeHandle` to its own file would clarify responsibilities. |
| `types.ts` | 239 | Clean. The `AppState` discriminated union is well-designed. |

### Minor: `get_timestamp()` and `log_ts!` are copy-pasted (`lib.rs:12–25`, `scanner.rs:18–40`)

Both files define identical functions and macros. Move to a `src-tauri/src/util.rs` module.

### Minor: Hardcoded developer machine path (`scanner.rs:54`)

```rust
r"C:\Users\xman2\AppData\Local\Programs\ExifTool\ExifTool.exe",
```

This leaks the developer's username and won't work for any other user. Use `dirs::data_local_dir()` or document an env-var override.

---

## 6. Test Coverage

### What's well covered

- `WorkQueue` has excellent unit + concurrent tests covering FIFO, prioritize, abort, timeout-based flushing.
- `scanner.rs` tests cover extension matching, recursion, cancellation, thumbnail extraction.
- Column sorting, resize, drag-reorder, column dialog all have dedicated test files.
- Performance tests validate batching behavior quantitatively.

### Gaps

**`useMediaLibrary.test.ts` is missing several critical paths:**

- **`scan_error` event** is never tested — the handler that resets state to idle without a guard is untested.
- **`worker_error` event** is never tested — no test verifies it appends to `workerErrors` or that it's idempotent.
- **Stale scan_id rejection** — there's no test that emitting events with an old scan_id is ignored. The `photo_found events after closeFolder` test covers a related case but not the scan_id mismatching scenario (e.g., emit with `scanId - 1`).
- **Cancel-and-restart** — no test starts a scan, emits some photos, starts a new scan, and verifies the old photos are gone and the new scan's events are accepted.
- **`closeFolder` invokes `stop_scan`** — the test that events after `closeFolder` are ignored doesn't assert `stop_scan` was called.
- **`scan_complete` while in "loading" state** — if the scan finishes with zero photos, the app should transition to `loaded` with an empty list. Not tested.
- **`metadataVersion` increment only when sorted by image metadata** — the conditional in `flushMetadataBatch` is untested.

**Performance tests measure wall-clock time with loose thresholds (10 seconds for 1000 updates)**. This would never catch a 5× regression. The meaningful assertion is notification count, which the `batches metadata updates correctly` test already checks well. The timing assertions are noise.

**No integration test for the Rust scan pipeline** — all Rust tests are pure unit tests on individual functions. The `start_scan` command logic (thread spawning, queue lifecycle, event emission) has no test coverage in Rust.

**`components.test.tsx` imports `LoadingScreen`** which is defined but not used in the production app flow (`App.tsx` renders its own inline loading state, not `<LoadingScreen>`). The tests for it are therefore testing a dead component.

**`photolist-prioritization.test.tsx`** has an unnecessary cast `vi.fn() as (paths: string[]) => void`. Minor, but indicates the test type inference isn't clean.

**`factories.ts` is 14 lines** and every test file either imports it or recreates equivalent setup inline. The factory for a `PhotoInfo` is used everywhere but `date_modified`/`date_created` always default to the same timestamp. Tests that care about sort order by date need to override inline, making test setup verbose.

---

## Summary

The highest-priority fixes in order:

1. **Race condition**: remove or guard the final `*thumbnails_arc.lock().unwrap() = None` block (lib.rs:459–462) — it can null out a live scan's queues.
2. **`scan_error` without scan_id** — add `scan_id` to `ScanErrorPayload` and guard the frontend listener.
3. **OS column header positions** — compute `gridColumn` from `visibleOSColumns.indexOf()` instead of hardcoding; without this, drag-reorder silently displays mismatched headers.
4. **O(N) scroll scan in `notify()`** — iterate visible paths only, not the full photo list.
5. **`gridColumns` as prop causes O(N) re-renders on resize** — use a CSS custom property instead.
6. **Subscriber Set leak** — add one line to the unsubscribe closure.
7. **Silent JSON parse failure in `parse_exiftool_batch_json`** — log the error before `unwrap_or_default()`.
8. **Hardcoded developer path in `find_exiftool`** — replace with platform dirs or a config var.
9. **Test the `scan_error`/`worker_error` paths and the cancel-restart flow** — these are the most likely states to produce broken UI in production.
10. **Deduplicate header JSX and the `get_timestamp`/`log_ts!` macro** — straightforward cleanup.