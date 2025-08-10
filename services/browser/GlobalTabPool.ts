
import { WebContentsView } from 'electron';
import { BaseService } from '../base/BaseService';
import { TabState } from '../../shared/types/window.types';
import { BrowserEventBus } from './BrowserEventBus';

// Type definition for WebContentsView with custom properties
interface ExtendedWebContentsView extends WebContentsView {
  _tabId?: string;
  setBorderRadius: (radius: number) => void;
  // destroy() is an undocumented internal method that exists at runtime
  // but isn't in Electron's TypeScript definitions (see issue #42884)
  destroy?: () => void;
}

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
  private pool: Map<string, ExtendedWebContentsView> = new Map();
  private lruOrder: string[] = []; // Tab IDs, most recent first
  private preservedState: Map<string, Partial<TabState>> = new Map();
  private tabToWindowMapping: Map<string, string> = new Map(); // tabId -> windowId
  private eventHandlerCleanups: Map<string, () => void> = new Map(); // tabId -> cleanup function
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
   * @param windowId The window that owns this tab (required for event context)
   * @returns The acquired WebContentsView.
   */
  public async acquireView(tabId: string, windowId: string): Promise<ExtendedWebContentsView> {
    return this.execute('acquireView', async () => {
      this.logInfo(`[ACQUIRE VIEW] Starting acquisition for Tab ${tabId}, Window ${windowId}`);
      
      // Check if already in pool first
      if (this.pool.has(tabId)) {
        const view = this.pool.get(tabId)!;
        const currentUrl = view.webContents.getURL();
        this.logInfo(`[REUSE VIEW] Tab ${tabId} already in pool with URL: ${currentUrl || 'blank'}`);
        
        // Check for window transfer
        const previousWindowId = this.tabToWindowMapping.get(tabId);
        if (previousWindowId && previousWindowId !== windowId) {
          this.logInfo(`[TAB TRANSFER] Tab ${tabId} moving from window ${previousWindowId} to ${windowId}`);
        }
        
        // CRITICAL: Re-attach event handlers with new window context
        this.attachEventHandlers(view, tabId, windowId);
        this.tabToWindowMapping.set(tabId, windowId);
        this.logInfo(`[TAB-WINDOW MAPPING] Updated: Tab ${tabId} -> Window ${windowId}`);
        
        this.updateLRU(tabId);
        return view;
      }

      this.logInfo(`[NEW VIEW NEEDED] Tab ${tabId} not in pool, creating new view`);
      
      if (this.pool.size >= this.MAX_POOL_SIZE) {
        this.logInfo(`[POOL FULL] Pool at capacity (${this.MAX_POOL_SIZE}), evicting oldest`);
        await this.evictOldest();
      }

      // Create the view first, THEN set mapping only if successful
      try {
        const view = this.createView(tabId, windowId);
        
        // Only set mapping after successful view creation
        // Map maintains ONE entry per tabId - subsequent calls overwrite, not accumulate
        this.tabToWindowMapping.set(tabId, windowId);
        this.logInfo(`[TAB-WINDOW MAPPING] Created: Tab ${tabId} -> Window ${windowId}`);
        
        this.pool.set(tabId, view);
        this.updateLRU(tabId);
        
        this.logInfo(`[ACQUIRE COMPLETE] Tab ${tabId} view ready, pool size: ${this.pool.size}`);
        return view;
      } catch (error) {
        // Clean up any partial state on failure
        this.tabToWindowMapping.delete(tabId);
        this.preservedState.delete(tabId);
        this.logError(`[ACQUIRE ERROR] Failed to create view for tab ${tabId}:`, error);
        throw error;
      }
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
        // Clean up event handlers BEFORE clearing mapping
        this.cleanupEventHandlers(tabId);
        
        // Now safe to clear state
        this.pool.delete(tabId);
        this.lruOrder = this.lruOrder.filter(id => id !== tabId);
        this.preservedState.delete(tabId);
        this.tabToWindowMapping.delete(tabId);
        
        await this.destroyView(view);
      }
    });
  }

  /**
   * Retrieves a view from the pool if it exists.
   * Does not affect LRU order.
   */
  public getView(tabId: string): ExtendedWebContentsView | undefined {
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
      
      // Notify interested services that this tab is about to be evicted
      // This allows them to capture snapshots or perform other cleanup
      if (windowId) {
        this.deps.eventBus.emit('tab:before-evict', { 
          windowId, 
          tabId: oldestTabId 
        });
      }
      
      await this.releaseView(oldestTabId);
    }
  }

  /**
   * Creates a new WebContentsView instance.
   * @param tabId The ID of the tab
   * @param windowId Window ID for immediate event context
   */
  private createView(tabId: string, windowId: string): ExtendedWebContentsView {
    const securePrefs: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: undefined,
      webSecurity: true,
      plugins: true,
    };

    this.logInfo(`[CREATE VIEW] Creating WebContentsView for Tab ${tabId} in Window ${windowId}`);
    
    const view = new WebContentsView({ webPreferences: securePrefs }) as ExtendedWebContentsView;
    view.setBackgroundColor('#00000000'); // Transparent background
    
    this.logInfo(`[VIEW CREATED] WebContentsView instance created for Tab ${tabId}`);
    
    // Apply border radius to the native view (6px to match 8px outer radius with 2px border)
    // Note: setBorderRadius is a custom Electron method that may not be available in all builds
    if (view.setBorderRadius) {
      view.setBorderRadius(6);
    }

    // Set up WebContents event handlers with proper window context
    this.attachEventHandlers(view, tabId, windowId);

    // Restore minimal state if it exists
    const state = this.preservedState.get(tabId);
    if (state?.url) {
      this.logInfo(`[URL ASSOCIATION] Tab ${tabId} <- URL: ${state.url}`);
      this.logInfo(`[LOAD START] Tab ${tabId} beginning navigation to ${state.url}`);
      
      view.webContents.loadURL(state.url).then(() => {
        this.logInfo(`[LOAD INITIATED] Tab ${tabId} loadURL() completed for ${state.url}`);
      }).catch((error) => {
        this.logError(`[LOAD ERROR] Tab ${tabId} failed to load ${state.url}:`, error);
      });
    } else {
      this.logWarn(`[NO URL] Tab ${tabId} created without URL - view is blank`);
    }

    this.logInfo(`[CREATE COMPLETE] WebContentsView for Tab ${tabId} ready`);
    return view;
  }

  /**
   * Clean up event handlers for a specific tab
   */
  private cleanupEventHandlers(tabId: string): void {
    const cleanup = this.eventHandlerCleanups.get(tabId);
    if (cleanup) {
      cleanup();
      this.eventHandlerCleanups.delete(tabId);
    }
  }

  /**
   * Attach event handlers to a view with the current window context
   */
  private attachEventHandlers(view: ExtendedWebContentsView, tabId: string, windowId: string): void {
    // Clean up any existing handlers first
    this.cleanupEventHandlers(tabId);

    // Create handlers with windowId captured in closure
    const handlers = this.createEventHandlers(tabId, windowId);
    const webContents = view.webContents;

    // Attach all handlers - use type assertions for each event type
    (webContents as any).on('did-start-loading', handlers['did-start-loading']);
    (webContents as any).on('did-stop-loading', handlers['did-stop-loading']);
    (webContents as any).on('did-navigate', handlers['did-navigate']);
    (webContents as any).on('did-navigate-in-page', handlers['did-navigate-in-page']);
    (webContents as any).on('page-title-updated', handlers['page-title-updated']);
    (webContents as any).on('page-favicon-updated', handlers['page-favicon-updated']);
    (webContents as any).on('did-fail-load', handlers['did-fail-load']);
    (webContents as any).on('focus', handlers['focus']);
    (webContents as any).on('blur', handlers['blur']);
    (webContents as any).on('context-menu', handlers['context-menu']);

    // Handle window open requests (special case - uses setWindowOpenHandler)
    webContents.setWindowOpenHandler((details) => {
      this.logDebug(`Tab ${tabId} window open request:`, details);
      
      // Use the windowId captured in closure
      this.deps.eventBus.emit('view:window-open-request', { windowId, details });
      
      // Always deny the default behavior - we handle it ourselves
      return { action: 'deny' };
    });

    // Store cleanup function
    this.eventHandlerCleanups.set(tabId, () => {
      webContents.removeAllListeners();
      // Clear the window open handler by removing it
      webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
      });
    });

    // Store reference to cleanup listeners when view is destroyed
    view._tabId = tabId; // Store tabId for cleanup reference
  }

  /**
   * Create event handlers with windowId captured in closure
   */
  private createEventHandlers(tabId: string, windowId: string) {
    return {
      'did-start-loading': () => {
        this.logInfo(`[PAGE LOADING] Tab ${tabId} started loading`);
        this.deps.eventBus.emit('view:did-start-loading', { tabId, windowId });
      },
      'did-stop-loading': () => {
        const view = this.pool.get(tabId);
        if (view && !view.webContents.isDestroyed()) {
          const webContents = view.webContents;
          const currentState = this.preservedState.get(tabId) || {};
          const url = webContents.getURL() || currentState.url || '';
          const title = webContents.getTitle() || currentState.title || 'Untitled';
          const canGoBack = webContents.canGoBack();
          const canGoForward = webContents.canGoForward();
          
          this.logInfo(`[PAGE LOADED] Tab ${tabId} finished loading: ${url} (${title})`);
          
          this.deps.eventBus.emit('view:did-stop-loading', { 
            windowId, 
            url, 
            title, 
            canGoBack, 
            canGoForward, 
            tabId 
          });
        } else {
          this.logWarn(`[PAGE LOADED] Tab ${tabId} stopped loading but view not found`);
        }
      },
      'did-navigate': (event: Event, url: string, httpResponseCode?: number, httpStatusText?: string) => {
        this.logInfo(`[NAVIGATION] Tab ${tabId} navigated to: ${url} (HTTP ${httpResponseCode} ${httpStatusText || ''})`);
        
        // Update preserved state with new URL
        const currentState = this.preservedState.get(tabId) || {};
        this.preservedState.set(tabId, { ...currentState, url });
        this.logInfo(`[URL UPDATED] Tab ${tabId} URL state updated to: ${url}`);
        
        // Get the view to access webContents for title
        const view = this.pool.get(tabId);
        if (view && !view.webContents.isDestroyed()) {
          const title = view.webContents.getTitle() || currentState.title || 'Untitled';
          this.deps.eventBus.emit('view:did-navigate', { windowId, url, title, tabId });
        }
      },
      'did-navigate-in-page': (event: Event, url: string, isMainFrame: boolean) => {
        if (isMainFrame) {
          this.logInfo(`[IN-PAGE NAV] Tab ${tabId} navigated in-page to: ${url}`);
          // Update preserved state for in-page navigation too
          const currentState = this.preservedState.get(tabId) || {};
          this.preservedState.set(tabId, { ...currentState, url });
        }
      },
      'page-title-updated': (event: Event, title: string) => {
        // Update preserved state with new title
        const currentState = this.preservedState.get(tabId) || {};
        this.preservedState.set(tabId, { ...currentState, title });
        
        // Emit with the windowId captured at handler creation time
        this.deps.eventBus.emit('view:page-title-updated', { windowId, title, tabId });
      },
      'page-favicon-updated': (event: Event, favicons: string[]) => {
        // Update preserved state with new favicon
        const faviconUrl = favicons.length > 0 ? favicons[0] : null;
        const currentState = this.preservedState.get(tabId) || {};
        this.preservedState.set(tabId, { ...currentState, faviconUrl });
        
        // Emit with the windowId captured at handler creation time
        this.deps.eventBus.emit('view:page-favicon-updated', { windowId, faviconUrl: favicons, tabId });
      },
      'did-fail-load': (event: Event, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
        if (isMainFrame) {
          this.logError(`[LOAD FAILED] Tab ${tabId} failed to load ${validatedURL}: ${errorDescription} (Error Code: ${errorCode})`);
        }
      },
      'focus': () => {
        this.logDebug(`Tab ${tabId} gained focus`);
      },
      'blur': () => {
        this.logDebug(`Tab ${tabId} lost focus`);
      },
      'context-menu': (event: Event, params: Electron.ContextMenuParams) => {
        this.logDebug(`Tab ${tabId} context menu requested at (${params.x}, ${params.y})`);
        
        // Get the view for bounds
        const view = this.pool.get(tabId);
        if (view) {
          const viewBounds = view.getBounds();
          
          // Emit event with windowId from closure
          this.deps.eventBus.emit('view:context-menu-requested', {
            windowId,
            params,
            viewBounds
          });
        }
      }
    };
  }


  /**
   * Destroys a WebContentsView and preserves its state.
   */
  private async destroyView(view: ExtendedWebContentsView): Promise<void> {
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) {
      const tabId = view._tabId;
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
        (view as ExtendedWebContentsView).destroy?.();
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
   * Migrate a tab to a different window without destroying the view.
   * Re-attaches event handlers with the new window context.
   * 
   * @param tabId The ID of the tab to migrate
   * @param newWindowId The ID of the window to migrate to
   */
  public migrateTabToWindow(tabId: string, newWindowId: string): void {
    const view = this.pool.get(tabId);
    if (view && newWindowId) {
      // Re-attach handlers with new window context
      this.attachEventHandlers(view, tabId, newWindowId);
      this.tabToWindowMapping.set(tabId, newWindowId);
      this.logInfo(`Migrated tab ${tabId} to window ${newWindowId}`);
    } else {
      this.logWarn(`Cannot migrate tab ${tabId} - view not found or no windowId provided`);
    }
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
    
    // Clean up event handlers for orphaned tabs
    tabsToClean.forEach(tabId => {
      this.cleanupEventHandlers(tabId);  // Remove event handlers
      this.tabToWindowMapping.delete(tabId);
    });
    
    if (tabsToClean.length > 0) {
      this.logDebug(`Cleaned up ${tabsToClean.length} tab mappings and event handlers for window ${windowId}`);
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
    this.eventHandlerCleanups.clear();
  }
}
