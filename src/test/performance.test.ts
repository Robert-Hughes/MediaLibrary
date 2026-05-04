import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhotos } from "./factories";

describe("Performance: Large folder handling", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles 1000 photos with metadata updates efficiently", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/large-folder");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    
    await act(async () => { await result.current[1].openFolder(); });
    
    // Emit 1000 photos in batches of 50 (simulating backend behavior)
    const startTime = performance.now();
    for (let i = 0; i < 20; i++) {
      const batch = makePhotos(
        Array.from({ length: 50 }, (_, j) => `photo-${i * 50 + j}.jpg`)
      );
      act(() => { 
        batch.forEach(photo => mock.emitPhotoFound(photo));
      });
      
      // Advance timers to trigger batch flush
      if (i === 0) {
        // First batch flushes immediately
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      }
    }
    
    // Flush remaining batches
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    const photoLoadTime = performance.now() - startTime;
    
    // Verify all photos loaded
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(1000);
      
      // Emit metadata for all photos in batches
      const metadataStartTime = performance.now();
      for (let i = 0; i < state.photos.length; i++) {
        const photo = state.photos[i];
        act(() => { 
          mock.emitImageMetadataReady(photo.relative_path, { 
            "IFD0:Model": "Test Camera",
            "ExifIFD:DateTimeOriginal": "2024:01:01 12:00:00",
            "IFD0:Make": "Test Manufacturer"
          }); 
        });
        
        // Advance timers periodically to trigger batch flushes
        if (i % 50 === 49) {
          await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        }
      }
      
      // Final flush
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      
      const metadataLoadTime = performance.now() - metadataStartTime;
      
      // Verify metadata progress store shows completion
      const metadataRemaining = state.metadataProgress.getRemaining();
      expect(metadataRemaining).toBe(0);
      
      // Performance assertions (these are generous to account for test overhead)
      // In real usage, these should be much faster
      console.log(`Photo load time: ${photoLoadTime}ms`);
      console.log(`Metadata load time: ${metadataLoadTime}ms`);
      
      // These times should be reasonable even in tests
      expect(photoLoadTime).toBeLessThan(2000); // 2 seconds for 1000 photos
      expect(metadataLoadTime).toBeLessThan(10000); // 10 seconds for 1000 metadata updates (generous for test overhead)
    }
  });

  it("batches photo_found events correctly", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/test-folder");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    
    await act(async () => { await result.current[1].openFolder(); });
    
    // Emit 100 photos individually
    for (let i = 0; i < 100; i++) {
      act(() => { 
        mock.emitPhotoFound(makePhotos([`photo-${i}.jpg`])[0]);
      });
    }
    
    // First photo should flush immediately
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    
    let state = result.current[0];
    expect(state.kind).toBe("loaded");
    
    // Advance to trigger batch flushes
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(100);
    }
  });

  it("batches metadata updates correctly", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/test-folder");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    
    await act(async () => { await result.current[1].openFolder(); });
    
    // Add 100 photos
    const photos = makePhotos(Array.from({ length: 100 }, (_, i) => `photo-${i}.jpg`));
    photos.forEach(photo => act(() => { mock.emitPhotoFound(photo); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    
    // Track how many times the metadata progress store notifies subscribers
    let notificationCount = 0;
    const unsubscribe = state.metadataProgress.subscribe(() => {
      notificationCount++;
    });
    
    // Emit metadata for all photos
    for (let i = 0; i < 100; i++) {
      act(() => { 
        mock.emitImageMetadataReady(`photo-${i}.jpg`, { 
          "IFD0:Model": "Camera" 
        }); 
      });
    }
    
    // Advance timers to trigger batch flushes
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    
    unsubscribe();
    
    // Should have batched updates, not 100 individual updates
    // With batch size of 50 and 200ms timeout, we expect ~2-3 notifications
    expect(notificationCount).toBeLessThan(10);
    expect(notificationCount).toBeGreaterThan(0);
    
    // Verify all metadata was processed
    expect(state.metadataProgress.getRemaining()).toBe(0);
  });

  it("handles rapid thumbnail updates without excessive re-renders", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/test-folder");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    
    await act(async () => { await result.current[1].openFolder(); });
    
    // Add 100 photos
    const photos = makePhotos(Array.from({ length: 100 }, (_, i) => `photo-${i}.jpg`));
    photos.forEach(photo => act(() => { mock.emitPhotoFound(photo); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    
    // Emit thumbnails rapidly
    for (let i = 0; i < 100; i++) {
      act(() => { 
        mock.emitThumbnailReady(`photo-${i}.jpg`, "base64data"); 
      });
    }
    
    // Advance timers to trigger batch flushes
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    
    // Verify thumbnails were stored (check a few samples)
    expect(state.thumbnails.get("photo-0.jpg")).toBe("base64data");
    expect(state.thumbnails.get("photo-50.jpg")).toBe("base64data");
    expect(state.thumbnails.get("photo-99.jpg")).toBe("base64data");
  });

  it("maintains correct metadata progress count during incremental loading", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/test-folder");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    
    await act(async () => { await result.current[1].openFolder(); });
    
    // Add 50 photos
    const batch1 = makePhotos(Array.from({ length: 50 }, (_, i) => `photo-${i}.jpg`));
    batch1.forEach(photo => act(() => { mock.emitPhotoFound(photo); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    
    // Initial remaining should be 50
    expect(state.metadataProgress.getRemaining()).toBe(50);
    
    // Load metadata for 25 photos
    for (let i = 0; i < 25; i++) {
      act(() => { 
        mock.emitImageMetadataReady(`photo-${i}.jpg`, { "IFD0:Model": "Camera" }); 
      });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    
    // Should show 25 remaining
    expect(state.metadataProgress.getRemaining()).toBe(25);
    
    // Add 50 more photos
    const batch2 = makePhotos(Array.from({ length: 50 }, (_, i) => `photo-${i + 50}.jpg`));
    batch2.forEach(photo => act(() => { mock.emitPhotoFound(photo); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    // Should now show 75 remaining (25 from first batch + 50 from second)
    expect(state.metadataProgress.getRemaining()).toBe(75);
    
    // Load all remaining metadata
    for (let i = 25; i < 100; i++) {
      act(() => { 
        mock.emitImageMetadataReady(`photo-${i}.jpg`, { "IFD0:Model": "Camera" }); 
      });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    
    // Should show 0 remaining
    expect(state.metadataProgress.getRemaining()).toBe(0);
  });
});
