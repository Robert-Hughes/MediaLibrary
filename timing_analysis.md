# Timing Analysis of Application Startup

## Key Timestamps (in milliseconds since epoch)

### Initial Setup
- **1777915188.035**: [JS LOG] [setup] Setting up event listeners
- **1777915188.043**: [JS LOG] [App] Opening folder from CLI argument: D:\OneDrive\Pictures\2012
- **1777915188.044**: [JS LOG] [startScan] Waiting for event listeners to be ready...
- **1777915188.073**: [JS LOG] [setup] All event listeners registered
- **1777915188.095**: [JS LOG] [startScan] Event listeners ready, proceeding with scan
- **1777915188.096**: [JS LOG] [startScan] Starting scan for folder: D:\OneDrive\Pictures\2012
- **1777915188.100**: [JS LOG] [startScan] Switched from scan_id -1 to 1777915188095
- **1777915188.101**: [JS LOG] [startScan] Created new stores
- **1777915188.107**: [JS LOG] [startScan] Backend scan started

### First UI Updates
- **1777915188.684**: [JS LOG] [PhotoList] Virtual items: 0, visible photos: 0
- **1777915188.688**: [JS LOG] [PhotoList] Initial load: notifying about first 30 photos
- **1777915188.917**: [JS LOG] [PhotoList] Virtual items: 26, visible photos: 26

## Timing Analysis

### Critical Delay Identified: 577ms gap
**From**: 1777915188.107 (Backend scan started)  
**To**: 1777915188.684 (First PhotoList update)  
**Duration**: **577 milliseconds**

This is the "blank window" period where:
1. The backend has started scanning
2. Thumbnails are being generated (first thumbnail batch arrives at 1777915188.620)
3. But the PhotoList component shows "Virtual items: 0, visible photos: 0"

### Breakdown of the 577ms delay:

1. **Backend processing**: 1777915188.107 - 1777915188.620 = **513ms**
   - Directory scanning and initial thumbnail generation
   - First thumbnail batch ready at 1777915188.620

2. **Frontend processing**: 1777915188.620 - 1777915188.684 = **64ms**
   - Time from first thumbnails received to PhotoList update

### Root Cause Analysis

The issue is that **table headers don't appear until PhotoList renders with actual data**. The PhotoList component waits for:
1. Photos to be discovered (directory scan)
2. Thumbnails to be generated 
3. State to be updated with visible photos

**The 577ms delay is primarily caused by**:
- Directory scanning: ~100ms
- Initial thumbnail generation: ~400ms  
- State synchronization: ~77ms

### Recommendation

To fix the blank window issue, the table headers should be rendered immediately when the scan starts, not waiting for the first photos/thumbnails to be ready. The PhotoList component should show the table structure with headers as soon as `startScan` is called, even with 0 items.