# Thumbnail Performance Investigation

## Problem
Thumbnail generation is extremely slow: **2-4 seconds per image** on a folder with 297 photos.

## Root Cause
Full image decoding using the `image` crate's JPEG decoder is the bottleneck.

## Attempted Solutions

### 1. EXIF Thumbnail Extraction (Failed)
**Approach**: Extract embedded thumbnails from EXIF data using `exiftool -b -ThumbnailImage`
**Status**: Not working - `exiftool` command not found when called from Rust worker threads
**Why it failed**: PATH environment variable not properly inherited by worker threads

### 2. Time-Based Batching (Implemented ✓)
**Approach**: Emit thumbnail batches every 500ms instead of waiting for 50 items
**Status**: Working - UI updates more frequently
**Impact**: Better UX but doesn't solve the underlying speed issue

## Current Performance
- **Per-image decode time**: 2-4 seconds
- **Total time for 297 images**: ~15-20 minutes with 8 workers
- **Throughput**: ~2-3 images/second across all workers

## Potential Solutions

### Option A: Fix EXIF Thumbnail Extraction
- Find exiftool executable path explicitly
- Or use a Rust EXIF library (e.g., `kamadak-exif`, `rexif`)
- **Expected speedup**: 10-100x faster (embedded thumbnails are pre-generated)

### Option B: Optimize Image Decoding
- Use `mozjpeg` or `libjpeg-turbo` bindings instead of pure Rust decoder
- Enable SIMD optimizations
- Use release build for testing (dev builds are unoptimized)
- **Expected speedup**: 2-5x faster

### Option C: Parallel Decoding with Lower Resolution
- Decode at lower resolution directly (if supported by decoder)
- Use faster resize algorithm (Nearest instead of default)
- **Expected speedup**: 2-3x faster

### Option D: Cache Thumbnails
- Generate thumbnails once and cache them to disk
- Store in a `.thumbnails` directory next to images
- **Expected speedup**: Instant on subsequent loads

## Recommendation
1. **Immediate**: Test with release build (`cargo build --release`) to see real performance
2. **Short-term**: Implement Option A (Rust EXIF library for embedded thumbnails)
3. **Medium-term**: Implement Option D (thumbnail caching)
4. **Long-term**: Consider Option B (faster JPEG decoder) if still needed

## Testing
Run with release build:
```bash
npm run tauri build
# Then run the built executable with folder argument
```

Check if embedded thumbnails exist:
```bash
exiftool -ThumbnailImage D:\OneDrive\Pictures\2012\IMAG0261.jpg
```
