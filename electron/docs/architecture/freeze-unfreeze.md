# Browser Window Freeze/Unfreeze Architecture

## Overview

The freeze/unfreeze architecture enables Enai to create the appearance of multiple overlapping browser windows while working within Electron's architectural constraints. Since WebContentsViews always render above HTML content regardless of z-index settings, this system uses a snapshot-based approach to simulate window layering. The architecture is tab-aware, supporting multiple tabs per window with individual snapshot management.

## Core Problem

In Electron applications:
- WebContentsViews (browser views) always render on top of all HTML content
- Traditional CSS z-index has no effect on WebContentsView layering
- Multiple WebContentsViews would require 150-250MB of memory each
- True window layering would require complex view removal/re-addition operations

## Architecture Components

### 1. Window State Synchronization

The system uses a unified flow for all window state synchronization:

```
Renderer WindowStore → WINDOW_STATE_UPDATE IPC → WindowStateHandler → BrowserEventBus → Services
```

All window state changes (focus, minimize/restore, z-index, freeze/unfreeze) propagate through this single pipeline.

### 2. Freeze State Machine

The system implements a four-state machine to manage browser window visibility:

#### States

- **ACTIVE**: The browser view is visible and interactive. This is the normal operating state when a window has focus.
- **CAPTURING**: The system is taking a snapshot of the current page. This is a transitional state during the async capture operation.
- **AWAITING_RENDER**: A snapshot has been captured and the system is waiting for the React component to render it in the UI.
- **FROZEN**: The snapshot is displayed as a static image and the actual browser view is hidden from view.

#### State Transitions

```
ACTIVE --[loses focus]--> CAPTURING --[snapshot taken]--> AWAITING_RENDER --[UI rendered]--> FROZEN
   ^                                                                                            |
   |------------------------[gains focus]-------------------------------------------------------|
```

The state machine is managed by the WindowStateHandler in the main process, with the renderer triggering transitions through state updates.

### 3. WindowStateHandler

The WindowStateHandler (`electron/ipc/windowStateHandler.ts`) coordinates all window state changes and manages freeze state transitions.

#### Responsibilities

- **State Change Detection**: Monitors window state changes from the renderer
- **Freeze State Transitions**: Manages ACTIVE → CAPTURING → AWAITING_RENDER → FROZEN flow
- **Snapshot Coordination**: Triggers snapshot capture when windows lose focus
- **Event Emission**: Emits events to BrowserEventBus for focus, minimize/restore, and z-order changes
- **Race Condition Prevention**: Tracks captures in progress to prevent duplicate operations

### 4. ClassicBrowserSnapshotService

The snapshot service manages the capture and storage of browser view snapshots with tab-aware functionality.

#### Key Features

- **Tab-Aware Storage**: Stores snapshots per tab using composite keys (`windowId:tabId`)
- **Async Capture**: Uses `webContents.capturePage()` to capture the current page state
- **LRU Cache**: Maintains up to 10 snapshots using a Least Recently Used eviction policy
- **Data URL Conversion**: Converts captured images to data URLs for easy embedding in HTML
- **Security**: Skips capturing authentication URLs to protect sensitive information
- **Direct Integration**: Called directly by GlobalTabPool via `captureBeforeEviction()` to capture snapshots before tabs are evicted
- **Cache Fallback**: Returns cached snapshots when browser view is not in the tab pool

#### Public Methods

- `captureSnapshot(windowId)`: Captures and stores a snapshot of the active tab, returns `{ url: string; snapshot: string }` or `undefined`
- `captureSnapshotString(windowId)`: Simplified method that returns just the snapshot string for backward compatibility
- `freezeWindow(windowId)`: Captures snapshot and updates state to FROZEN
- `unfreezeWindow(windowId)`: Updates state to ACTIVE
- `showAndFocusView(windowId)`: Debug method for logging snapshot availability
- `clearSnapshot(windowId)`: Removes all snapshots for a window
- `clearTabSnapshot(windowId, tabId)`: Removes snapshot for a specific tab
- `getSnapshot(windowId)`: Retrieves snapshot for the active tab (backward compatibility)
- `getTabSnapshot(windowId, tabId)`: Retrieves snapshot for a specific tab
- `getAllSnapshots()`: Returns all stored snapshots
- `clearAllSnapshots()`: Removes all snapshots (used during cleanup)

### 5. Controller Hook (useBrowserWindowController)

The controller hook manages freeze state transitions in the renderer.

#### Responsibilities

- **Focus Monitoring**: Watches for window focus changes and triggers state transitions
- **State Management**: Updates the freeze state in the window store
- **Snapshot Loaded Callback**: Transitions from AWAITING_RENDER to FROZEN when snapshot is rendered

### 6. React Component Integration

The ClassicBrowser component renders based on the current freeze state:

```typescript
// When frozen or awaiting render, show the snapshot
{(isAwaitingRender || isFrozen) && snapshotUrl && (
  <div className="absolute inset-0">
    <img src={snapshotUrl} className="w-full h-full" />
  </div>
)}

// The actual browser view is only visible when ACTIVE
<div style={{ opacity: showWebContentsView ? 1 : 0 }}>
  {/* WebContentsView renders here */}
</div>
```

## Implementation Flow

### Freezing Process

1. **Focus Loss Detection**: The useBrowserWindowController hook detects when a browser window loses focus
2. **State Transition**: Updates state from ACTIVE to CAPTURING in the renderer's window store
3. **IPC Sync**: useWindowStateSync sends the updated state via WINDOW_STATE_UPDATE
4. **Main Process Handling**: WindowStateHandler detects the ACTIVE → CAPTURING transition
5. **Snapshot Capture**: WindowStateHandler calls ClassicBrowserSnapshotService.captureSnapshot()
6. **Image Processing**: The service captures the page and converts to data URL
7. **State Update**: WindowStateHandler updates state to AWAITING_RENDER with the snapshot URL
8. **State Propagation**: ClassicBrowserStateService emits state change to renderer
9. **UI Rendering**: React component renders the snapshot image
10. **Final State**: Component signals completion via handleSnapshotLoaded, state becomes FROZEN

### Unfreezing Process

1. **Focus Gain Detection**: The useBrowserWindowController hook detects when a browser window gains focus
2. **State Transition**: Updates state directly to ACTIVE in the renderer's window store
3. **IPC Sync**: useWindowStateSync sends the updated state via WINDOW_STATE_UPDATE
4. **Main Process Handling**: WindowStateHandler detects the transition to ACTIVE
5. **State Update**: WindowStateHandler updates ClassicBrowserStateService to ACTIVE
6. **Snapshot Cleanup**: WindowStateHandler calls snapshotService.clearSnapshot()
7. **UI Update**: React component hides snapshot and shows the live view

## IPC Architecture

### Primary Channel

- `WINDOW_STATE_UPDATE`: Single channel for all window state synchronization

### Legacy Channels (Deprecated)

- `BROWSER_FREEZE_VIEW`: Legacy snapshot capture endpoint (returns snapshot but doesn't manage state)
- `BROWSER_UNFREEZE_VIEW`: Legacy unfreeze endpoint (no-op, kept for compatibility)

### Main Process Handler

```typescript
// windowStateHandler.ts
ipcMain.on(WINDOW_STATE_UPDATE, async (event, windows: WindowMeta[]) => {
  // Process all window state changes including freeze transitions
  // Detects ACTIVE → CAPTURING and triggers snapshot
  // Detects transitions to ACTIVE and clears snapshots
  // Emits events to BrowserEventBus for all state changes
});
```

### Renderer Process API

```typescript
// Primary API (through preload script)
window.api.updateWindowState(windows: WindowMeta[]): void  // Sends all window state updates

// Legacy APIs (deprecated, minimal functionality)
window.api.captureSnapshot(windowId): Promise<string | null>  // Returns snapshot only
window.api.showAndFocusView(windowId): Promise<void>          // No-op
window.api.freezeBrowserView(windowId): Promise<string | null> // Alias for captureSnapshot
window.api.unfreezeBrowserView(windowId): Promise<void>       // Alias for showAndFocusView
```

## Memory Management

### Snapshot Storage

- Maximum of 10 snapshots stored at any time (across all windows and tabs)
- LRU eviction when limit is reached
- Snapshots stored as base64 data URLs in memory with composite keys (`windowId:tabId`)
- Automatic cleanup on service shutdown
- Event-driven storage from GlobalTabPool when tabs are evicted from the pool

### Tab Pool Strategy

The system integrates with GlobalTabPool for efficient memory management:
- Limited number of WebContentsViews active at once (controlled by tab pool)
- Automatic snapshot capture when tabs are evicted from the pool
- Cached snapshots used when tabs are not in the active pool
- Memory usage remains bounded regardless of total tab count

## Security Considerations

### Authentication URL Protection

The system includes built-in protection for authentication flows:

```typescript
if (isAuthenticationUrl(currentUrl)) {
  return undefined; // Skip snapshot capture
}
```

This prevents capturing:
- Login forms
- OAuth flows
- Password reset pages
- Other sensitive authentication states

## Integration with Window Management

### Window Store Integration

The freeze state is stored as part of the ClassicBrowserPayload:

```typescript
interface ClassicBrowserPayload {
  tabs: BrowserTab[];
  activeTabId: string;
  freezeState: BrowserFreezeState;
  tabGroupId?: string;
  tabGroupTitle?: string;
}
```

### State Management Integration

The freeze state management follows a unidirectional flow:
- Renderer's window store is the source of truth for state changes
- WindowStateHandler processes state changes and triggers appropriate actions
- ClassicBrowserStateService broadcasts state updates back to renderer
- All state synchronization occurs through the WINDOW_STATE_UPDATE channel

### Sidebar Hover Behavior

The notebook view includes special handling for sidebar interactions:
- Hovering over the sidebar triggers a freeze of the active browser window
- This prevents the browser from obscuring sidebar content
- The freeze is released when the sidebar is no longer hovered

## State Persistence

The freeze state is intentionally not persisted across application restarts. All windows start in the ACTIVE state when the application launches, ensuring a clean initialization without stale snapshots. However, snapshots may be temporarily cached in memory during a session for tabs that are evicted from the GlobalTabPool.