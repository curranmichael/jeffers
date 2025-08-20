
import { WebContentsView, Event } from 'electron';
import { BaseService } from '../base/BaseService';
import { TabState } from '../../shared/types/window.types';
import { BrowserEventBus } from './BrowserEventBus';
import type { ClassicBrowserSnapshotService } from './ClassicBrowserSnapshotService';
import { isAuthenticationUrl } from './url.helpers';

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
  snapshotService: ClassicBrowserSnapshotService;
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
        const currentUrl = view.webContents?.getURL() || '';
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
        // Remove from pool immediately (synchronous)
        this.pool.delete(tabId);
        this.lruOrder = this.lruOrder.filter(id => id !== tabId);
        
        // Clean up event handlers synchronously
        this.cleanupEventHandlers(tabId);
        
        // Clear state synchronously
        this.tabToWindowMapping.delete(tabId);
        
        // Destroy view without blocking
        this.destroyView(view);
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
      const view = this.pool.get(oldestTabId);
      const windowId = this.getWindowIdForTab(oldestTabId);
      
      // Capture snapshot before evicting the view, passing the view directly
      if (windowId && view) {
        await this.deps.snapshotService.captureBeforeEviction(windowId, oldestTabId, view);
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
      partition: 'persist:browser', // Use persistent partition for cookies/storage
      javascript: true, // Explicitly enable JavaScript
      experimentalFeatures: true, // Enable experimental features for better compatibility
    };

    this.logInfo(`[CREATE VIEW] Creating WebContentsView for Tab ${tabId} in Window ${windowId}`);
    
    const view = new WebContentsView({ webPreferences: securePrefs }) as ExtendedWebContentsView;
    
    try {
      view.setBackgroundColor('#00000000'); // Transparent background
      
      // Set user agent to match standard Chrome
      const chromeVersion = process.versions.chrome;
      const platform = process.platform;
      let userAgent: string;
      
      if (platform === 'darwin') {
        // macOS
        userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      } else if (platform === 'win32') {
        // Windows
        userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      } else {
        // Linux and others
        userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      }
      
      view.webContents?.setUserAgent(userAgent);
      this.logInfo(`[USER AGENT] Set for Tab ${tabId}: ${userAgent}`);
      
      // Verify it was actually set
      const actualUserAgent = view.webContents?.getUserAgent();
      if (actualUserAgent && actualUserAgent !== userAgent) {
        this.logWarn(`[USER AGENT] Mismatch! Expected: ${userAgent}, Actual: ${actualUserAgent}`);
      }
      
      this.logInfo(`[VIEW CREATED] WebContentsView instance created for Tab ${tabId}`);
      
      // Apply border radius to the native view (6px to match 8px outer radius with 2px border)
      // Note: setBorderRadius is a custom Electron method that may not be available in all builds
      if (view.setBorderRadius) {
        view.setBorderRadius(6);
      }

      // Set up WebContents event handlers with proper window context
      this.attachEventHandlers(view, tabId, windowId);

      // New views start blank - URL will be set by the caller if needed
      this.logInfo(`[VIEW READY] Tab ${tabId} created - awaiting navigation`);

      this.logInfo(`[CREATE COMPLETE] WebContentsView for Tab ${tabId} ready`);
      return view;
    } catch (error) {
      // Critical: Destroy the view if any initialization fails to prevent resource leak
      this.logError(`[CREATE VIEW ERROR] Failed to initialize view for Tab ${tabId}:`, error);
      this.destroyViewSafely(view);
      throw error;
    }
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

    // Attach all handlers
    webContents.on('did-start-loading', handlers['did-start-loading']);
    webContents.on('did-stop-loading', handlers['did-stop-loading']);
    webContents.on('will-navigate', handlers['will-navigate']);
    webContents.on('did-navigate', handlers['did-navigate']);
    webContents.on('did-navigate-in-page', handlers['did-navigate-in-page']);
    webContents.on('page-title-updated', handlers['page-title-updated']);
    webContents.on('page-favicon-updated', handlers['page-favicon-updated']);
    webContents.on('did-fail-load', handlers['did-fail-load']);
    webContents.on('focus', handlers['focus']);
    webContents.on('blur', handlers['blur']);
    webContents.on('context-menu', handlers['context-menu']);
    webContents.on('dom-ready', handlers['dom-ready']);
    webContents.on('did-frame-finish-load', handlers['did-frame-finish-load']);

    // Handle window open requests (special case - uses setWindowOpenHandler)
    webContents.setWindowOpenHandler((details) => {
      this.logDebug(`Tab ${tabId} window open request:`, details);
      
      // Check if this is an OAuth/SSO flow
      const currentUrl = webContents?.getURL() || '';
      const isCurrentPageAuth = currentUrl ? isAuthenticationUrl(currentUrl) : false;
      const isPopupAuth = isAuthenticationUrl(details.url);
      
      // Allow popups for OAuth flows
      if (isCurrentPageAuth || isPopupAuth) {
        this.logInfo(`[OAUTH POPUP] Allowing popup for OAuth flow: ${details.url} (from page: ${currentUrl})`);
        return { action: 'allow' };
      }
      
      // For non-OAuth popups, emit event for handling new tabs
      this.deps.eventBus.emit('view:window-open-request', { windowId, details });
      
      // Deny unwanted popups (ads, etc)
      return { action: 'deny' };
    });

    // Store cleanup function
    this.eventHandlerCleanups.set(tabId, () => {
      if (webContents && !webContents.isDestroyed()) {
        webContents.removeAllListeners();
        // Clear the window open handler by removing it
        webContents.setWindowOpenHandler(() => {
          return { action: 'deny' };
        });
      }
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
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        this.logInfo(`[PAGE LOADING] Tab ${tabId} started loading`);
        this.deps.eventBus.emit('view:did-start-loading', { tabId, windowId });
      },
      'did-stop-loading': () => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Aligned safety check
        
        const url = view.webContents?.getURL() || '';
        const title = view.webContents?.getTitle() || 'Untitled';
        const canGoBack = view.webContents?.canGoBack() || false;
        const canGoForward = view.webContents?.canGoForward() || false;
        
        this.logInfo(`[PAGE LOADED] Tab ${tabId} finished loading: ${url} (${title})`);
        
        this.deps.eventBus.emit('view:did-stop-loading', { 
          windowId, 
          url, 
          title, 
          canGoBack, 
          canGoForward, 
          tabId 
        });
      },
      'did-navigate': (event: Event, url: string, httpResponseCode?: number, httpStatusText?: string) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        this.logInfo(`[NAVIGATION] Tab ${tabId} navigated to: ${url} (HTTP ${httpResponseCode} ${httpStatusText || ''})`);
        
        // Special handling for Figma SSO completion
        if (url.includes('finish_google_sso')) {
          this.logInfo(`[FIGMA SSO] Detected Figma OAuth callback, monitoring for completion...`);
        }
        
        const title = view.webContents?.getTitle() || 'Untitled';
        this.deps.eventBus.emit('view:did-navigate', { windowId, url, title, tabId });
      },
      'did-navigate-in-page': (event: Event, url: string, isMainFrame?: boolean) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        // Safely handle isMainFrame parameter which might be undefined
        const isMain = isMainFrame === true; // Explicit boolean conversion
        
        if (isMain) {
          this.logInfo(`[IN-PAGE NAV] Tab ${tabId} navigated in-page to: ${url}`);
        }
      },
      'will-navigate': (event: Event, url: string) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        // Check if this is an OAuth redirect
        const currentUrl = view.webContents?.getURL() || '';
        if (currentUrl && (currentUrl.includes('finish_google_sso') || currentUrl.includes('oauth') || currentUrl.includes('callback'))) {
          this.logInfo(`[OAUTH NAVIGATION] Allowing navigation from OAuth callback ${currentUrl} to ${url}`);
          // Don't prevent the navigation for OAuth flows
          return;
        }
        
        this.logInfo(`[WILL NAVIGATE] Tab ${tabId} will navigate to: ${url}`);
      },
      'page-title-updated': (event: Event, title: string) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        // Emit with the windowId captured at handler creation time
        this.deps.eventBus.emit('view:page-title-updated', { windowId, title, tabId });
      },
      'page-favicon-updated': (event: Event, favicons: string[]) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        // Emit with the windowId captured at handler creation time
        this.deps.eventBus.emit('view:page-favicon-updated', { windowId, faviconUrl: favicons, tabId });
      },
      'did-fail-load': (event: Event, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame?: boolean) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        // Safely handle isMainFrame parameter which might be undefined
        const isMain = isMainFrame === true; // Explicit boolean conversion
        
        if (isMain) {
          // ERR_ABORTED (-3) on OAuth callback URLs is expected - the page redirects after processing
          if (errorCode === -3 && (validatedURL.includes('finish_google_sso') || validatedURL.includes('oauth') || validatedURL.includes('callback'))) {
            this.logInfo(`[OAUTH REDIRECT] OAuth callback page aborted navigation (expected behavior): ${validatedURL}`);
          } else {
            this.logError(`[LOAD FAILED] Tab ${tabId} failed to load ${validatedURL}: ${errorDescription} (Error Code: ${errorCode})`);
          }
        }
      },
      'focus': () => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        this.logDebug(`Tab ${tabId} gained focus`);
      },
      'blur': () => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        this.logDebug(`Tab ${tabId} lost focus`);
      },
      'context-menu': (event: Event, params: Electron.ContextMenuParams) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        this.logDebug(`Tab ${tabId} context menu requested at (${params.x}, ${params.y})`);
        
        const viewBounds = view.getBounds();
        
        // Emit event with windowId from closure
        this.deps.eventBus.emit('view:context-menu-requested', {
          windowId,
          params,
          viewBounds
        });
      },
      'dom-ready': () => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        const url = view.webContents?.getURL() || '';
        this.logInfo(`[DOM READY] Tab ${tabId} DOM is ready for: ${url}`);
        
        this.deps.eventBus.emit('view:dom-ready', { 
          tabId, 
          windowId,
          url
        });
      },
      'did-frame-finish-load': (event: Event, isMainFrame?: boolean) => {
        const view = this.pool.get(tabId);
        if (!view || view.webContents?.isDestroyed()) return; // Safety check
        
        // Safely handle isMainFrame parameter which might be undefined
        const isMain = isMainFrame === true; // Explicit boolean conversion
        
        if (isMain) {
          const url = view.webContents?.getURL() || '';
          const title = view.webContents?.getTitle() || 'Untitled';
          
          this.logInfo(`[FRAME LOADED] Tab ${tabId} main frame finished loading: ${url} (${title})`);
          
          this.deps.eventBus.emit('view:did-frame-finish-load', {
            tabId,
            windowId,
            url,
            title,
            isMainFrame: isMain
          });
        } else {
          this.logDebug(`[FRAME LOADED] Tab ${tabId} sub-frame finished loading`);
        }
      }
    };
  }


  /**
   * Destroys a WebContentsView without blocking.
   */
  private destroyView(view: ExtendedWebContentsView): void {
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) {
      // Stop new operations immediately
      wc.setAudioMuted(true);
      wc.stop();
      
      // Remove listeners and close - fire and forget
      wc.removeAllListeners();
      wc.close();
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
   * Safely destroys a WebContentsView during error recovery.
   * Used when view initialization fails to prevent resource leaks.
   * Silently handles any errors since we're already in error recovery.
   */
  private destroyViewSafely(view: ExtendedWebContentsView): void {
    try {
      const wc = view.webContents;
      if (wc && !wc.isDestroyed()) {
        // Stop new operations immediately
        wc.setAudioMuted(true);
        wc.stop();
        
        // Remove listeners and close - fire and forget
        wc.removeAllListeners();
        wc.close();
      }
    } catch {
      // Silent fail - we're already in error recovery
      this.logDebug(`Failed to destroy view during error recovery`);
    }
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
    this.tabToWindowMapping.clear();
    this.eventHandlerCleanups.clear();
  }
}
