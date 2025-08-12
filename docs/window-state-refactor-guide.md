# Window State & Freeze Sync Refactoring Guide

## Overview

This guide provides a detailed implementation plan for refactoring the window lifecycle management system in the Enai application. The refactoring streamlines window state synchronization by removing duplicate systems and unifying the flow from the React window store to the Electron main process.

### Current Architecture Issues

The existing architecture has three overlapping paths that can race each other:

1. **WindowLifecycleService + IPC**: Renderer calls `window.api.windowLifecycleStateChanged` on every update, diffusing into events on the BrowserEventBus
2. **Manual Stack Sync IPC**: Renderer calls `window.api.syncWindowStackOrder` for z-index changes, duplicating WindowLifecycleService work
3. **Freeze/Unfreeze State Machine**: Complex 4-state FSM (ACTIVE → CAPTURING → AWAITING_RENDER → FROZEN) with renderer managing freeze logic

**Problems:**
- Multiple flows updating window state leading to race conditions
- Dual ownership of freeze state (renderer and main process)
- Complex call stacks with independent pipelines that must coordinate
- ~500+ lines of redundant code with potential synchronization issues

### Target Architecture

After refactoring, there will be **one clear flow**:

```
Renderer WindowStore → Single IPC (WINDOW_STATE_UPDATE) → Main Handler → BrowserEventBus → ClassicBrowserViewManager
```

All window state changes (focus, minimize/restore, z-index, freeze/unfreeze) will propagate through this single pipeline.

## Phase 1: Delete Redundant Systems

**Goal:** Remove the old WindowLifecycle sync and window stack order logic entirely.

### Files to Delete

1. **WindowLifecycleService and test**
   - `services/browser/WindowLifecycleService.ts`
   - `services/browser/_tests/WindowLifecycleService.test.ts`

2. **IPC Handlers**
   - `electron/ipc/windowLifecycleHandler.ts`
   - `electron/ipc/syncWindowStackOrder.ts`
   - `electron/ipc/_tests/syncWindowStackOrder.test.ts`

3. **React Hook**
   - `src/hooks/useWindowLifecycleSync.ts`

4. **Test Files (if purely for removed sync logic)**
   - `src/app/notebook/_tests/window-sync.test.tsx` (review first)

### Code Removals

#### In `electron/bootstrap/serviceBootstrap.ts`
- Remove import of `WindowLifecycleService`
- Remove instantiation in Phase 6 initialization
- Remove `registry.windowLifecycleService` assignment

#### In `electron/bootstrap/registerIpcHandlers.ts`
- Remove import: `registerWindowLifecycleHandler`
- Remove import: `registerSyncWindowStackOrderHandler`
- Remove registration calls for both handlers
- Remove `serviceRegistry.windowLifecycleService` references

#### In `src/components/NotebookView.tsx`
- Remove import of `useWindowLifecycleSync`
- Remove hook usage: `useWindowLifecycleSync(activeStore)` (around line 309)
- **Remove entire effect block** (lines 443-493) that calls `window.api.syncWindowStackOrder`

#### In `electron/preload.ts`
- Remove `window.api.windowLifecycleStateChanged` function
- Remove `window.api.syncWindowStackOrder` function
- Remove imports: `WINDOW_LIFECYCLE_STATE_CHANGED`, `SYNC_WINDOW_STACK_ORDER`

#### In `shared/types/api.types.ts`
- Remove from `IAppAPI` interface:
  - `windowLifecycleStateChanged`
  - `syncWindowStackOrder`

#### In `shared/ipcChannels.ts`
- Remove constants:
  - `WINDOW_LIFECYCLE_STATE_CHANGED`
  - `SYNC_WINDOW_STACK_ORDER`

#### Update Test Mocks
- **`src/components/apps/classic-browser/_tests/classicBrowserMocks.ts`**
  - Remove `syncWindowStackOrder: vi.fn()` (line ~150)
  - Remove `windowLifecycleStateChanged: vi.fn()` (line ~80)

- **`src/_tests/helpers/mockWindowApi.ts`**
  - Remove `syncWindowStackOrder` mock (line ~133)
  - Remove `windowLifecycleStateChanged` mock (line ~108)

- **`test-setup/electron-mocks.ts`**
  - Remove any `window.api.syncWindowStackOrder` assignments
  - Remove any `window.api.windowLifecycleStateChanged` assignments

## Phase 2: Create Single Direct IPC Handler

**Goal:** Establish a unified IPC bridge replacing both old channels.

### New IPC Channel Setup

#### Add to `shared/ipcChannels.ts`
```typescript
export const WINDOW_STATE_UPDATE = 'window:state-update';
```

#### Create `electron/ipc/windowStateHandler.ts`
```typescript
export function registerWindowStateHandler(
  ipcMain: IpcMain,
  eventBus: BrowserEventBus,
  snapshotService: ClassicBrowserSnapshotService,
  stateService: ClassicBrowserStateService
) {
  const previousWindows = new Map<string, WindowMeta>();
  const capturesInProgress = new Set<string>();

  ipcMain.on(WINDOW_STATE_UPDATE, async (event, windows: WindowMeta[]) => {
    logger.debug('[WindowStateHandler] Received update:', windows.length, 'windows');
    
    const browserWindows = windows.filter(w => w.type === 'classic-browser');
    
    for (const window of browserWindows) {
      const prev = previousWindows.get(window.id);
      
      // Focus changes
      if (prev && prev.isFocused !== window.isFocused) {
        eventBus.emit('window:focus-changed', {
          windowId: window.id,
          isFocused: window.isFocused,
          zIndex: window.zIndex
        });
      }
      
      // Minimize/restore
      if (prev && prev.isMinimized !== window.isMinimized) {
        if (window.isMinimized) {
          eventBus.emit('window:minimized', { windowId: window.id });
        } else {
          eventBus.emit('window:restored', { 
            windowId: window.id, 
            zIndex: window.zIndex 
          });
        }
      }
      
      // Freeze state changes
      const currentFreezeState = window.payload?.freezeState?.type;
      const prevFreezeState = prev?.payload?.freezeState?.type;
      
      if (currentFreezeState !== prevFreezeState) {
        // Handle ACTIVE → CAPTURING transition
        if (prevFreezeState === 'ACTIVE' && currentFreezeState === 'CAPTURING') {
          if (!capturesInProgress.has(window.id)) {
            capturesInProgress.add(window.id);
            
            try {
              const snapshot = await snapshotService.captureSnapshot(window.id);
              
              // Check if still should be frozen
              const latestWindow = windows.find(w => w.id === window.id);
              if (latestWindow?.payload?.freezeState?.type !== 'ACTIVE') {
                if (snapshot) {
                  await stateService.setState(window.id, {
                    ...stateService.getState(window.id),
                    freezeState: { 
                      type: 'FROZEN', 
                      snapshotUrl: snapshot.snapshot 
                    }
                  });
                }
              }
            } finally {
              capturesInProgress.delete(window.id);
            }
          }
        }
        
        // Handle FROZEN → ACTIVE transition
        if ((prevFreezeState === 'FROZEN' || prevFreezeState === 'CAPTURING') && 
            currentFreezeState === 'ACTIVE') {
          await stateService.setState(window.id, {
            ...stateService.getState(window.id),
            freezeState: { type: 'ACTIVE' }
          });
        }
      }
      
      // Update previous state
      previousWindows.set(window.id, window);
    }
    
    // Check for z-order changes
    const hasBrowserWindowCountChanged = browserWindows.length !== previousWindows.size;
    const hasZIndexChanged = browserWindows.some(w => {
      const prev = previousWindows.get(w.id);
      return prev && prev.zIndex !== w.zIndex;
    });
    
    if (hasBrowserWindowCountChanged || hasZIndexChanged) {
      const orderedWindows = browserWindows
        .map(w => ({
          windowId: w.id,
          zIndex: w.zIndex,
          isFocused: w.isFocused,
          isMinimized: w.isMinimized
        }))
        .sort((a, b) => a.zIndex - b.zIndex);
        
      eventBus.emit('window:z-order-update', orderedWindows);
    }
  });
}
```

#### Update `electron/preload.ts`
```typescript
updateWindowState: (windows: WindowMeta[]) => {
  console.log('[Preload] Sending window state update:', windows.length, 'windows');
  return ipcRenderer.send(WINDOW_STATE_UPDATE, windows);
}
```

#### Update `shared/types/api.types.ts`
```typescript
interface IAppAPI {
  // ... other methods
  updateWindowState: (windows: WindowMeta[]) => void;
  // Remove: windowLifecycleStateChanged, syncWindowStackOrder
}
```

#### Register in `electron/bootstrap/registerIpcHandlers.ts`
```typescript
import { registerWindowStateHandler } from '../ipc/windowStateHandler';

// In the registration section:
if (serviceRegistry.browserEventBus && serviceRegistry.classicBrowserSnapshot) {
  registerWindowStateHandler(
    ipcMain,
    serviceRegistry.browserEventBus,
    serviceRegistry.classicBrowserSnapshot,
    serviceRegistry.classicBrowserState
  );
  logger.info('[IPC] WindowStateUpdate handler registered');
}
```

### Create New React Hook

#### Create `src/hooks/useWindowStateSync.ts`
```typescript
import { useEffect } from 'react';
import { StoreApi } from 'zustand';
import { WindowStoreState } from '@/store/windowStore';

export function useWindowStateSync(store: StoreApi<WindowStoreState>) {
  useEffect(() => {
    if (!window.api?.updateWindowState) {
      console.warn('[WindowStateSync] API not available');
      return;
    }

    // Send initial state
    const initialState = store.getState();
    window.api.updateWindowState(initialState.windows);

    // Subscribe to changes
    const unsubscribe = store.subscribe(
      (state) => state.windows,
      (windows) => {
        window.api.updateWindowState(windows);
      }
    );

    return unsubscribe;
  }, [store]);
}
```

#### Use in `src/components/NotebookView.tsx`
```typescript
import { useWindowStateSync } from '@/hooks/useWindowStateSync';

// In the component (replace old hook usage):
useWindowStateSync(activeStore);
```

### Update Test Mocks
Add `updateWindowState: vi.fn()` to all test mock files where API is mocked.

## Phase 3: Simplify Freeze State Management

**Goal:** Main process manages freeze/unfreeze actions, renderer only updates state.

### Modify ClassicBrowserSnapshotService

#### In `services/browser/ClassicBrowserSnapshotService.ts`

**Remove from `freezeWindow` method (lines ~164-168):**
```typescript
// DELETE THIS BLOCK:
stateService.setState(windowId, {
  ...state,
  freezeState: { type: 'FROZEN', snapshotUrl: result.snapshot }
});
```

**Remove from `unfreezeWindow` method (lines ~180-183):**
```typescript
// DELETE THIS BLOCK:
stateService.setState(windowId, {
  ...state,
  freezeState: { type: 'ACTIVE' }
});
```

### Simplify useBrowserWindowController

#### In `src/hooks/useBrowserWindowController.ts`

**Keep:** First useEffect (focus monitoring)

**Remove:** Second useEffect (lines ~93-176) containing:
- `operationInProgress` ref and logic
- Switch statement handling CAPTURING/ACTIVE
- Calls to `api.captureSnapshot` and `api.showAndFocusView`
- Timeout logic

**Keep:** `handleSnapshotLoaded` callback (may need adjustment)

### Update ClassicBrowserViewManager

#### Consolidate View Maps

**Current state:** Three maps (`activeViews`, `frozenViews`, `minimizedViews`)

**Target state:** Single `views` map with visibility toggling

#### Changes in `services/browser/ClassicBrowserViewManager.ts`

1. **Remove properties:**
   - `private frozenViews: Map<string, WebContentsView>`
   - `private minimizedViews: Map<string, WebContentsView>`

2. **Rename `activeViews` to `views`**

3. **Update `handleWindowMinimized`:**
```typescript
const view = this.views.get(windowId);
if (view) {
  this.setViewVisibility(view, false);
}
// Remove: transfer to minimizedViews
```

4. **Update `handleWindowRestored`:**
```typescript
const view = this.views.get(windowId);
if (view) {
  this.setViewVisibility(view, true);
  if (bounds) view.setBounds(bounds);
}
// Remove: transfer from minimizedViews
```

5. **Update `handleStateChange` for freeze:**
```typescript
// For freeze (to FROZEN):
if (newState.freezeState?.type === 'FROZEN') {
  const view = this.views.get(windowId);
  if (view) {
    this.setViewVisibility(view, false);
  }
  return;
}

// For unfreeze (FROZEN → ACTIVE):
if (previousState?.freezeState?.type === 'FROZEN' && 
    newState.freezeState?.type === 'ACTIVE') {
  const view = this.views.get(windowId);
  if (view) {
    this.setViewVisibility(view, true);
    if (newState.bounds) view.setBounds(newState.bounds);
    view.webContents.focus(); // Important: restore focus
  }
}
```

6. **Update `handleZOrderUpdate`:**
```typescript
const activeWindowsInOrder = orderedWindows
  .filter(w => !w.isMinimized)
  .sort((a, b) => a.zIndex - b.zIndex);

for (const { windowId } of activeWindowsInOrder) {
  const view = this.views.get(windowId); // Single map lookup
  if (view) {
    this.bringViewToTop(view);
  }
}
```

### Ensure Renderer Receives Snapshot Updates

The renderer needs to listen for `ON_CLASSIC_BROWSER_STATE` events to receive snapshot URLs from main.

Check/implement listener in window store or NotebookView to merge incoming state updates with snapshot data.

## Phase 4: Final Cleanup

**Goal:** Remove remaining vestiges and ensure consistency.

### Remove from ClassicBrowserService

#### In `services/browser/ClassicBrowserService.ts`
- Delete `syncViewStackingOrder` method (around line 443)
- Update tests to remove references

### Verify Complete Removal
- No references to `WindowLifecycleService` anywhere
- No references to `WINDOW_LIFECYCLE_STATE_CHANGED` or `SYNC_WINDOW_STACK_ORDER`
- Test mocks updated

### Optional: Adjust Freeze/Unfreeze IPC
The `captureSnapshot` and `showAndFocusView` APIs can remain but become:
- `captureSnapshot`: Returns snapshot without freezing (screenshot utility)
- `showAndFocusView`: No-op (for backward compatibility)

### Documentation Updates
- Update `docs/freeze.md` to reflect new architecture
- Note removal of ~500 lines of redundant code
- Document the unified flow

## Testing Checklist

### Phase 1 Tests
- [ ] Application builds without removed files
- [ ] No TypeScript errors from removed references
- [ ] Tests pass without old mocks

### Phase 2 Tests
- [ ] Window focus changes propagate to main
- [ ] Minimize/restore works correctly
- [ ] Z-order updates when windows change
- [ ] Initial state syncs on mount

### Phase 3 Tests
- [ ] Freeze on focus loss (snapshot captured, view hidden)
- [ ] Unfreeze on focus gain (view shown, snapshot removed)
- [ ] Freeze with UI overlay (sidebar hover)
- [ ] Multiple windows freeze/unfreeze independently
- [ ] Rapid focus switching doesn't cause races

### Phase 4 Tests
- [ ] Full test suite passes
- [ ] Manual QA scenarios:
  - Multiple overlapping windows
  - Fast focus switching
  - Window close while others frozen
  - CPU usage drops when frozen
  - Video playback pauses on freeze

## Implementation Notes

### Critical Considerations

1. **Snapshot Delivery**: Main must send snapshot URL via `ON_CLASSIC_BROWSER_STATE` event
2. **Race Prevention**: Track captures in progress to prevent duplicate freezes
3. **Focus Restoration**: Call `webContents.focus()` when unfreezing
4. **Hidden Window Ordering**: Hidden views shouldn't interfere with hit testing
5. **State Consistency**: Renderer state drives everything; main reacts

### Performance Optimizations

- Consider debouncing `updateWindowState` if needed (unlikely with modest window counts)
- Clear snapshot cache on unfreeze to free memory
- Use single view map to reduce lookup overhead

### Migration Strategy

1. Implement on feature branch
2. Complete Phase 1 & 2 together (to avoid broken state)
3. Test thoroughly between phases
4. Deploy with monitoring for any race conditions

## Success Metrics

- **Code Reduction**: ~500 lines removed
- **Complexity**: 3 separate flows → 1 unified flow
- **Race Conditions**: Eliminated duplicate state sources
- **Performance**: Fewer IPC calls, simpler view management
- **Maintainability**: Clear single path for all window state changes

## Rollback Plan

If issues arise:
1. Git revert the merge commit
2. Restore from pre-refactor branch
3. Analyze logs for root cause
4. Address specific issues before re-attempting

## Appendix: File References

### Files Being Deleted (Phase 1)
- services/browser/WindowLifecycleService.ts
- services/browser/_tests/WindowLifecycleService.test.ts
- electron/ipc/windowLifecycleHandler.ts
- electron/ipc/syncWindowStackOrder.ts
- electron/ipc/_tests/syncWindowStackOrder.test.ts
- src/hooks/useWindowLifecycleSync.ts

### Files Being Created (Phase 2)
- electron/ipc/windowStateHandler.ts
- src/hooks/useWindowStateSync.ts

### Files Being Modified (All Phases)
- electron/bootstrap/serviceBootstrap.ts
- electron/bootstrap/registerIpcHandlers.ts
- electron/preload.ts
- shared/ipcChannels.ts
- shared/types/api.types.ts
- src/components/NotebookView.tsx
- src/hooks/useBrowserWindowController.ts
- services/browser/ClassicBrowserSnapshotService.ts
- services/browser/ClassicBrowserViewManager.ts
- services/browser/ClassicBrowserService.ts

### Test Files Requiring Updates
- src/components/apps/classic-browser/_tests/classicBrowserMocks.ts
- src/_tests/helpers/mockWindowApi.ts
- test-setup/electron-mocks.ts
- Various service test files