
import { WebContentsView } from 'electron';
import { BaseService } from '../base/BaseService';
import { TabState } from '../../shared/types/window.types';
import { BrowserEventBus } from './BrowserEventBus';

export interface GlobalTabPoolDeps {
  eventBus: BrowserEventBus;
}

/**
 * GlobalTabPool
 *
 * Manages a global pool of WebContentsViews to conserve memory.
 * Implements an LRU eviction policy. This service is a "dumb" factory,
 * controlled by the ClassicBrowserViewManager.
 */
export class GlobalTabPool extends BaseService<GlobalTabPoolDeps> {
  private pool: Map<string, WebContentsView> = new Map();
  private lruOrder: string[] = []; // Tab IDs, most recent first
  private preservedState: Map<string, Partial<TabState>> = new Map();
  private tabToWindowMapping: Map<string, string> = new Map(); // tabId -> windowId
  private readonly MAX_POOL_SIZE = 5;

  constructor(deps: GlobalTabPoolDeps) {
    super('GlobalTabPool', deps);
  }

  /**
   * Acquire a WebContentsView for a given tab.
   * If the tab is already in the pool, it's marked as most recently used.
   * If not, and the pool is full, the least recently used view is evicted.
   * A new view is then created.
   *
   * @param tabId The ID of the tab to acquire a view for.
   * @param windowId The window that owns this tab (for event context)
   * @returns The acquired WebContentsView.
   */
  public async acquireView(tabId: string, windowId?: string): Promise<WebContentsView> {
    return this.execute('acquireView', async () => {
      this.logInfo(`[ACQUIRE] Tab ${tabId}, windowId: ${windowId || 'NONE'}`);
      
      // Store the window mapping BEFORE creating the view
      // This ensures event handlers have access to the window ID
      if (windowId) {
        this.tabToWindowMapping.set(tabId, windowId);
        this.logInfo(`[MAPPING] Set tab ${tabId} -> window ${windowId}`);
      } else {
        this.logWarn(`[MAPPING] No windowId provided for tab ${tabId}`);
      }

      if (this.pool.has(tabId)) {
        this.logInfo(`[REUSE] Tab ${tabId} already in pool`);
        this.updateLRU(tabId);
        return this.pool.get(tabId)!;
      }

      if (this.pool.size >= this.MAX_POOL_SIZE) {
        await this.evictOldest();
      }

      // Now create the view - event handlers will have access to window mapping
      const view = this.createView(tabId, windowId);
      this.pool.set(tabId, view);
      this.updateLRU(tabId);

      return view;
    });
  }

  /**
   * Release a WebContentsView back to the pool, destroying it.
   * This should be called when a tab is closed.
   *
   * @param tabId The ID of the tab whose view should be released.
   */
  public async releaseView(tabId: string): Promise<void> {
    return this.execute('releaseView', async () => {
      const view = this.pool.get(tabId);
      if (view) {
        this.pool.delete(tabId);
        this.lruOrder = this.lruOrder.filter(id => id !== tabId);
        this.preservedState.delete(tabId);
        this.tabToWindowMapping.delete(tabId); // Clean up mapping
        await this.destroyView(view);
      }
    });
  }

  /**
   * Retrieves a view from the pool if it exists.
   * Does not affect LRU order.
   */
  public getView(tabId: string): WebContentsView | undefined {
    return this.pool.get(tabId);
  }

  /**
   * Get all tab IDs that have views in the pool.
   */
  public getAllViewIds(): string[] {
    return Array.from(this.pool.keys());
  }

  /**
   * Get the window ID that owns a specific tab.
   */
  private getWindowIdForTab(tabId: string): string | undefined {
    return this.tabToWindowMapping.get(tabId);
  }

  /**
   * Evicts the least recently used view from the pool.
   */
  private async evictOldest(): Promise<void> {
    const oldestTabId = this.lruOrder.pop();
    if (oldestTabId) {
      const windowId = this.getWindowIdForTab(oldestTabId);
      
      // Capture snapshot inline before eviction - no delay needed
      if (windowId) {
        const view = this.pool.get(oldestTabId);
        if (view && !view.webContents.isDestroyed()) {
          try {
            const image = await view.webContents.capturePage();
            const snapshot = image.toDataURL();
            // Emit event with captured snapshot
            this.deps.eventBus.emit('tab:snapshot-captured', { 
              windowId, 
              tabId: oldestTabId, 
              snapshot 
            });
          } catch (error) {
            // Silent fail - just evict without snapshot
            this.logDebug(`Failed to capture snapshot for tab ${oldestTabId}: ${error}`);
          }
        }
      }
      
      await this.releaseView(oldestTabId);
    }
  }

  /**
   * Creates a new WebContentsView instance.
   * @param tabId The ID of the tab
   * @param windowId Optional window ID for immediate event context
   */
  private createView(tabId: string, windowId?: string): WebContentsView {
    const securePrefs: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: undefined,
      webSecurity: true,
      plugins: true,
    };

    const view = new WebContentsView({ webPreferences: securePrefs });
    view.setBackgroundColor('#00000000'); // Transparent background
    
    // Apply border radius to the native view (6px to match 8px outer radius with 2px border)
    (view as any).setBorderRadius(6);

    // Set up WebContents event handlers for proper navigation tracking
    this.setupWebContentsEventHandlers(view, tabId);

    // Restore minimal state if it exists
    const state = this.preservedState.get(tabId);
    if (state?.url) {
      this.logInfo(`[LOAD URL] Tab ${tabId} loading preserved URL: ${state.url}`);
      view.webContents.loadURL(state.url);
    } else {
      this.logWarn(`[NO URL] Tab ${tabId} created without URL to load`);
    }

    return view;
  }

  /**
   * Sets up event handlers for WebContents to track navigation state
   */
  private setupWebContentsEventHandlers(view: WebContentsView, tabId: string): void {
    const webContents = view.webContents;

    // Track loading state
    webContents.on('did-start-loading', () => {
      this.logDebug(`Tab ${tabId} started loading`);
      const windowId = this.getWindowIdForTab(tabId);
      if (windowId) {
        this.deps.eventBus.emit('view:did-start-loading', { tabId, windowId });
      }
    });

    webContents.on('did-stop-loading', () => {
      this.logDebug(`Tab ${tabId} stopped loading`);
      const windowId = this.getWindowIdForTab(tabId);
      if (windowId) {
        this.deps.eventBus.emit('view:did-stop-loading', { tabId, windowId });
      }
    });

    // Track navigation events
    webContents.on('did-navigate', (event, url, httpResponseCode, httpStatusText) => {
      this.logDebug(`Tab ${tabId} navigated to: ${url}`);
      // Update preserved state with new URL
      const currentState = this.preservedState.get(tabId) || {};
      this.preservedState.set(tabId, { ...currentState, url });
      
      // Emit navigation event with window context
      const windowId = this.getWindowIdForTab(tabId);
      if (windowId) {
        // Extract title from current state or webContents
        const title = webContents.getTitle() || currentState.title || 'Untitled';
        this.deps.eventBus.emit('view:did-navigate', { windowId, url, title, tabId });
      }
    });

    webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
      if (isMainFrame) {
        this.logDebug(`Tab ${tabId} navigated in-page to: ${url}`);
        // Update preserved state for in-page navigation too
        const currentState = this.preservedState.get(tabId) || {};
        this.preservedState.set(tabId, { ...currentState, url });
      }
    });

    // Track title changes
    webContents.on('page-title-updated', (event, title) => {
      const windowId = this.getWindowIdForTab(tabId);
      // this.logInfo(`[TITLE] Tab ${tabId} title updated to: "${title}" (windowId: ${windowId || 'NO_WINDOW'})`);
      
      // Update preserved state with new title
      const currentState = this.preservedState.get(tabId) || {};
      this.preservedState.set(tabId, { ...currentState, title });
      
      // Emit to event bus with window and tab context
      if (windowId) {
        // this.logInfo(`[TITLE] Emitting title update event for window ${windowId}, tab ${tabId}`);
        this.deps.eventBus.emit('view:page-title-updated', { windowId, title, tabId });
      } else {
        // this.logWarn(`[TITLE] Cannot emit title update - no window mapping for tab ${tabId}`);
      }
    });

    // Track favicon changes
    webContents.on('page-favicon-updated', (event, favicons) => {
      const windowId = this.getWindowIdForTab(tabId);
      // this.logInfo(`[FAVICON] Tab ${tabId} favicon updated: ${favicons.length} favicons (windowId: ${windowId || 'NO_WINDOW'})`);
      
      // Update preserved state with new favicon
      const faviconUrl = favicons.length > 0 ? favicons[0] : null;
      const currentState = this.preservedState.get(tabId) || {};
      this.preservedState.set(tabId, { ...currentState, faviconUrl });
      
      // Emit to event bus with window and tab context
      if (windowId) {
        // this.logInfo(`[FAVICON] Emitting favicon update event for window ${windowId}, tab ${tabId} with URL: ${faviconUrl}`);
        this.deps.eventBus.emit('view:page-favicon-updated', { windowId, faviconUrl: favicons, tabId });
      } else {
        // this.logWarn(`[FAVICON] Cannot emit favicon update - no window mapping for tab ${tabId}`);
      }
    });

    // Track errors
    webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        this.logWarn(`Tab ${tabId} failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
        // TODO: Emit to event bus when available
        // this.eventBus?.emit('view:did-fail-load', { tabId, errorCode, errorDescription, validatedURL });
      }
    });

    // Track focus events that might trigger reloads on certain sites
    webContents.on('focus', () => {
      this.logDebug(`Tab ${tabId} gained focus`);
    });

    webContents.on('blur', () => {
      this.logDebug(`Tab ${tabId} lost focus`);
    });

    // Handle context menu (right-click) events
    webContents.on('context-menu', (event, params) => {
      this.logDebug(`Tab ${tabId} context menu requested at (${params.x}, ${params.y})`);
      
      // Get the window ID for this tab
      const windowId = this.getWindowIdForTab(tabId);
      if (windowId) {
        // Get the view bounds for positioning
        const viewBounds = view.getBounds();
        
        // Emit event through the event bus for ClassicBrowserService to handle
        this.deps.eventBus.emit('view:context-menu-requested', {
          windowId,
          params,  // Pass the entire ContextMenuParams object
          viewBounds
        });
      }
    });

    // Handle window open requests (CMD+click, middle-click, etc.)
    webContents.setWindowOpenHandler((details) => {
      this.logDebug(`Tab ${tabId} window open request:`, details);
      
      // Get the window ID for this tab
      const windowId = this.getWindowIdForTab(tabId);
      if (windowId) {
        // Emit event for ClassicBrowserService to handle
        this.deps.eventBus.emit('view:window-open-request', { windowId, details });
      }
      
      // Always deny the default behavior - we handle it ourselves
      return { action: 'deny' };
    });

    // Store reference to cleanup listeners when view is destroyed
    // Note: WebContents doesn't have a destroy method, cleanup happens in destroyView
    (view as any)._tabId = tabId; // Store tabId for cleanup reference
  }

  /**
   * Destroys a WebContentsView and preserves its state.
   */
  private async destroyView(view: WebContentsView): Promise<void> {
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) {
      const tabId = (view as any)._tabId;
      if (tabId) {
        // TODO: Enhance state preservation.
        // For now, we only preserve the URL. Later, we can add:
        // - Scroll position: `await wc.executeJavaScript(...)`
        // - Navigation history: `wc.navigationHistory.getEntries()`
        this.preservedState.set(tabId, { url: wc.getURL() });
      }

      // Clean up event listeners before destroying
      wc.removeAllListeners();
      wc.setAudioMuted(true);
      wc.stop();
      
      // Destroy the view itself (which will destroy the WebContents)
      try {
        (view as any).destroy?.();
      } catch (error) {
        // View already destroyed or destroy method not available
      }
    }
  }

  /**
   * Updates the LRU order for a given tab.
   */
  private updateLRU(tabId: string): void {
    this.lruOrder = this.lruOrder.filter(id => id !== tabId);
    this.lruOrder.unshift(tabId); // Add to the front (most recent)
  }

  

  /**
   * Remove all tab-to-window mappings for a specific window.
   * Called when a window is being destroyed to prevent stale mappings.
   */
  public cleanupWindowMappings(windowId: string): void {
    const tabsToClean: string[] = [];
    for (const [tabId, winId] of this.tabToWindowMapping.entries()) {
      if (winId === windowId) {
        tabsToClean.push(tabId);
      }
    }
    tabsToClean.forEach(tabId => this.tabToWindowMapping.delete(tabId));
    if (tabsToClean.length > 0) {
      this.logDebug(`Cleaned up ${tabsToClean.length} tab mappings for window ${windowId}`);
    }
  }

  /**
   * Cleans up all views in the pool.
   */

  public async cleanup(): Promise<void> {
    const allTabs = Array.from(this.pool.keys());
    await Promise.all(allTabs.map(tabId => this.releaseView(tabId)));
    this.pool.clear();
    this.lruOrder = [];
    this.preservedState.clear();
    this.tabToWindowMapping.clear();
  }
}
