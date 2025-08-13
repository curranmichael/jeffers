# Tab-Pool Branch Migration Guide

## Overview
This guide helps you import functionality from the main branch into the tab-pool branch architecture. The tab-pool branch fundamentally changes how WebContentsView instances are managed, introducing a pooled resource model with centralized state management.

## Core Architectural Differences

### 1. WebContentsView Management
- **Main**: Direct 1:1 mapping between windows and WebContentsViews
- **Tab-Pool**: Pooled WebContentsViews with LRU eviction (max 5 active views)

### 2. Service Dependencies
- **Main**: Services directly depend on ClassicBrowserViewManager
- **Tab-Pool**: Services depend on GlobalTabPool and ClassicBrowserViewManager

### 3. State Management
- **Main**: State distributed across services
- **Tab-Pool**: Centralized state in ClassicBrowserStateService with event-driven updates

## Migration Steps for New Features

### Step 1: Understand the New Service Architecture

In tab-pool branch, functionality is split across:
- **GlobalTabPool**: Manages WebContentsView lifecycle and pooling
- **ClassicBrowserViewManager**: Handles view presentation and window attachment
- **ClassicBrowserStateService**: Single source of truth for browser state
- **WindowLifecycleService**: Manages window-level events and state

### Step 2: Identify Feature Location

When importing a feature from main, determine where it belongs:

| Feature Type | Main Branch Location | Tab-Pool Branch Location |
|-------------|---------------------|-------------------------|
| View creation/destruction | ClassicBrowserViewManager | GlobalTabPool |
| View attachment/detachment | ClassicBrowserViewManager | ClassicBrowserViewManager |
| WebContents event handling | ClassicBrowserViewManager | GlobalTabPool |
| Tab state management | ClassicBrowserStateService | ClassicBrowserStateService |
| Navigation logic | ClassicBrowserNavigationService | ClassicBrowserNavigationService + GlobalTabPool |
| Window state tracking | ClassicBrowserService | WindowLifecycleService |
| Browser operations | ClassicBrowserService | ClassicBrowserService (coordinated) |

### Step 3: Adapt WebContentsView Access

#### Main Branch Pattern:
```typescript
const view = this.views.get(windowId);
if (view) {
  view.webContents.loadURL(url);
}
```

#### Tab-Pool Branch Pattern:
```typescript
// First check if tab has an active view
let view = this.deps.globalTabPool.getView(tabId);
if (!view) {
  // Acquire from pool (may evict another view)
  view = await this.deps.globalTabPool.acquireView(tabId, windowId);
}
view.webContents.loadURL(url);
```

### Step 4: Handle State Changes

#### Main Branch Pattern:
```typescript
// Direct state mutation
this.states.set(windowId, newState);
// Manual event emission
this.eventBus.emit('browser-state-changed', { windowId, state: newState });
```

#### Tab-Pool Branch Pattern:
```typescript
// Use setState method which handles events
this.setState(windowId, newState);
// This automatically emits 'state-changed' with navigation context
```

### Step 5: Adapt Event Handling

#### Main Branch Events:
- WebContents events handled in ClassicBrowserViewManager
- Direct event listener registration on view creation

#### Tab-Pool Branch Events:
- WebContents events handled in GlobalTabPool
- Events flow through BrowserEventBus to services
- Use event subscription pattern:

```typescript
// In service initialize()
this.deps.eventBus.on('view:did-navigate', this.handleNavigation.bind(this));
this.deps.eventBus.on('state-changed', this.handleStateChange.bind(this));
```

### Step 6: Handle Tab vs Window Context

The tab-pool branch distinguishes between tabs and windows more clearly:

- **Tab**: The content/page (has a tabId, can move between windows)
- **Window**: The container/frame (has a windowId, contains tabs)

When importing features, consider:
- Is this feature tab-specific? → Use tabId as primary key
- Is this feature window-specific? → Use windowId as primary key
- Does it need both? → Track the tab-to-window mapping

## Common Migration Patterns

### Pattern 1: Adding a New Browser Operation

#### Main Branch:
```typescript
// In ClassicBrowserService
public async doSomething(windowId: string): Promise<void> {
  const view = this.deps.viewManager.getView(windowId);
  if (view) {
    // Direct operation
    view.webContents.executeJavaScript('...');
  }
}
```

#### Tab-Pool Branch:
```typescript
// In ClassicBrowserService or appropriate sub-service
public async doSomething(windowId: string): Promise<void> {
  const state = this.deps.stateService.getState(windowId);
  if (!state?.activeTabId) return;
  
  const view = await this.deps.globalTabPool.acquireView(state.activeTabId, windowId);
  view.webContents.executeJavaScript('...');
}
```

### Pattern 2: Adding WebContents Event Handler

#### Main Branch:
```typescript
// In setupWebContentsListeners
wc.on('new-event', (event, data) => {
  this.deps.eventBus.emit('view:new-event', { windowId, data });
});
```

#### Tab-Pool Branch:
```typescript
// In GlobalTabPool.setupWebContentsEventHandlers
webContents.on('new-event', (event, data) => {
  const windowId = this.getWindowIdForTab(tabId);
  if (windowId) {
    this.deps.eventBus.emit('view:new-event', { windowId, tabId, data });
  }
});
```

### Pattern 3: State Updates

#### Main Branch:
```typescript
// Direct state update
const state = this.states.get(windowId);
state.someField = newValue;
this.eventBus.emit('state-updated', { windowId });
```

#### Tab-Pool Branch:
```typescript
// Immutable state update
const state = this.getState(windowId);
const newState = {
  ...state,
  someField: newValue
};
this.setState(windowId, newState);
// Event emission is automatic
```

## Feature-Specific Migration Notes

### Context Menus
- Already implemented in both branches
- Tab-pool uses overlay system in ClassicBrowserViewManager
- Main branch pattern can be adapted by ensuring overlay views aren't pooled

### Bookmarks
- Main branch: Integrated into TabState
- Tab-pool: Would need to preserve bookmark state during view eviction
- Add bookmark fields to `preservedState` in GlobalTabPool

### Navigation History
- Main branch: Direct access via `view.webContents.navigationHistory`
- Tab-pool: Need to preserve history in `preservedState` before eviction:

```typescript
// In GlobalTabPool.destroyView
this.preservedState.set(tabId, {
  url: wc.getURL(),
  navigationHistory: wc.navigationHistory.getEntries(),
  scrollPosition: await wc.executeJavaScript('({x: window.scrollX, y: window.scrollY})')
});
```

### Downloads
- Main branch: Handled in ClassicBrowserService
- Tab-pool: Should be handled at GlobalTabPool level since downloads are WebContents-specific
- Need to track active downloads and handle view eviction carefully

### Developer Tools
- Main branch: Direct `view.webContents.openDevTools()`
- Tab-pool: Need to ensure devtools windows aren't affected by pool eviction
- Consider marking tabs with open devtools as "pinned" to prevent eviction

## Testing Considerations

When importing features, test these scenarios:

1. **Pool Eviction**: Feature works when view is evicted and restored
2. **Tab Switching**: Feature state persists across tab switches
3. **Window Operations**: Feature handles minimize/restore correctly
4. **Multiple Windows**: Feature works with tabs in different windows
5. **State Consistency**: Feature state stays synchronized with browser state

## Performance Considerations

### Memory Impact
- Tab-pool limits memory usage but may cause more frequent state serialization
- Consider what state needs preservation vs what can be recreated

### CPU Impact
- Pool management adds overhead for view acquisition
- Event-driven architecture may add latency for state updates
- Batch operations where possible to reduce event storms

## Debugging Tips

1. **Enable debug logging**: Set `LOG_LEVEL=debug`
2. **Monitor pool state**: Add logging to GlobalTabPool.acquireView/releaseView
3. **Track state changes**: Log all setState calls in ClassicBrowserStateService
4. **Event flow**: Add temporary logging to BrowserEventBus.emit
5. **View lifecycle**: Log view creation/destruction in GlobalTabPool

## Common Pitfalls

1. **Assuming view availability**: Always check/acquire from pool first
2. **Direct state mutation**: Use setState for all state changes
3. **Missing event handlers**: Ensure services subscribe to necessary events
4. **Tab/Window confusion**: Be clear about which ID you're using
5. **Synchronous pool operations**: Remember acquireView is async

## Rollback Strategy

If a migrated feature causes issues:

1. **Feature flag**: Wrap new code in feature flags for easy disable
2. **Parallel implementation**: Keep both implementations during migration
3. **State compatibility**: Ensure state format works with both architectures
4. **Event compatibility**: Emit events that both architectures can handle

## Support and Questions

For questions about specific migration scenarios:
1. Check existing implementations in tab-pool branch
2. Review GlobalTabPool and ClassicBrowserViewManager for patterns
3. Test thoroughly with pool eviction scenarios
4. Consider memory and performance implications

Remember: The tab-pool architecture prioritizes memory efficiency and scalability over simplicity. When in doubt, follow the existing patterns in the tab-pool branch rather than directly porting main branch code.