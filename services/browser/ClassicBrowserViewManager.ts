
import { BrowserWindow, WebContentsView, app } from 'electron';
import * as path from 'path';
import { BaseService } from '../base/BaseService';
import { ClassicBrowserPayload, TabState } from '../../shared/types';
import { BrowserContextMenuData } from '../../shared/types/contextMenu.types';
import { BROWSER_CONTEXT_MENU_SHOW } from '../../shared/ipcChannels';
import { BrowserEventBus } from './BrowserEventBus';
import { GlobalTabPool } from './GlobalTabPool';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { isSecureUrl } from '../../utils/urlSecurity';

// Type definition for WebContentsView with custom properties
interface ExtendedWebContentsView extends WebContentsView {
  _lastNavigationTime?: number;
}

// Type definition for errors with code property
interface ErrorWithCode extends Error {
  code?: string;
}

export interface ClassicBrowserViewManagerDeps {
  mainWindow: BrowserWindow;
  eventBus: BrowserEventBus;
  globalTabPool: GlobalTabPool;
  stateService: ClassicBrowserStateService;
}

/**
 * Manages the presentation layer of the browser, ensuring the visual
 * state of WebContentsViews matches the application state.
 */
export class ClassicBrowserViewManager extends BaseService<ClassicBrowserViewManagerDeps> {
  private views: Map<string, WebContentsView> = new Map(); // windowId -> view (single map for all views)
  private viewToTabMapping: Map<WebContentsView, string> = new Map(); // view -> tabId
  
  // Overlay management properties
  private overlayViews: Map<string, WebContentsView> = new Map();
  private overlayTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private activeOverlayWindowIds: Set<string> = new Set();
  private overlayReadyPromises: Map<string, { promise: Promise<void>; resolve: () => void }> = new Map();

  constructor(deps: ClassicBrowserViewManagerDeps) {
    super('ClassicBrowserViewManager', deps);
  }

  async initialize(): Promise<void> {
    this.deps.eventBus.on('state-changed', this.handleStateChange.bind(this));
    // LEGACY: These individual event handlers will be consolidated into single state sync
    this.deps.eventBus.on('window:focus-changed', this.handleWindowFocusChanged.bind(this));
    this.deps.eventBus.on('window:minimized', this.handleWindowMinimized.bind(this));
    this.deps.eventBus.on('window:restored', this.handleWindowRestored.bind(this));
    this.deps.eventBus.on('window:z-order-update', this.handleZOrderUpdate.bind(this));
  }

  private async handleStateChange({ windowId, newState, previousState, isNavigationRelevant }: {
    windowId: string;
    newState: ClassicBrowserPayload;
    previousState?: ClassicBrowserPayload;
    isNavigationRelevant?: boolean;
  }): Promise<void> {
    await this.cleanupRemovedTabs(newState, previousState);

    // Check if window is frozen
    if (newState.freezeState?.type === 'FROZEN') {
      // Hide the view but keep it in the map
      const currentView = this.views.get(windowId);
      if (currentView) {
        // Hide the view but keep it attached
        this.setViewVisibility(currentView, false);
      }
      return; // Skip normal tab handling when frozen
    }

    // Handle transition from frozen to active
    if (previousState?.freezeState?.type === 'FROZEN' &&
        newState.freezeState?.type === 'ACTIVE') {
      // Check if we have a view to restore
      const view = this.views.get(windowId);
      if (view) {
        // Make the view visible again
        this.setViewVisibility(view, true);
        // Update bounds if needed
        if (newState.bounds) {
          view.setBounds(newState.bounds);
        }
        // Restore focus to webContents
        view.webContents.focus();
        
        // Skip navigation check - the view was just hidden, not detached
        // The content should still be intact
      } else if (newState.activeTabId) {
        // Fallback: Re-acquire view if we don't have one
        const view = await this.deps.globalTabPool.acquireView(newState.activeTabId, windowId);
        this.views.set(windowId, view);
        this.viewToTabMapping.set(view, newState.activeTabId);
        this.setViewState(view, true, newState.bounds);
        
        const activeTab = newState.tabs.find(tab => tab.id === newState.activeTabId);
        if (activeTab) {
          await this.ensureViewNavigatedToTab(view, activeTab);
        }
      }
      return;
    }

    const activeTabId = newState.activeTabId;
    const currentView = this.views.get(windowId);
    const currentViewTabId = this.findTabIdForView(currentView);

    if (currentViewTabId === activeTabId) {
      this.handleActiveTabUpdate(windowId, newState, previousState, isNavigationRelevant);
    } else {
      this.handleTabSwitch(windowId, newState, activeTabId, currentView);
    }
  }

  private async cleanupRemovedTabs(newState: ClassicBrowserPayload, previousState?: ClassicBrowserPayload): Promise<void> {
    if (!previousState) return;

    const removedTabIds = previousState.tabs
      .filter(prevTab => !newState.tabs.find(newTab => newTab.id === prevTab.id))
      .map(tab => tab.id);

    for (const removedTabId of removedTabIds) {
      await this.deps.globalTabPool.releaseView(removedTabId);
    }
  }

  private handleActiveTabUpdate(windowId: string, newState: ClassicBrowserPayload, previousState?: ClassicBrowserPayload, isNavigationRelevant?: boolean): void {
    const activeTabId = newState.activeTabId;
    const currentView = this.views.get(windowId);

    if (currentView && newState.bounds) {
      currentView.setBounds(newState.bounds);
    }

    if (isNavigationRelevant && previousState && previousState.activeTabId === activeTabId) {
      const activeTab = newState.tabs.find(tab => tab.id === activeTabId);
      const previousTab = previousState.tabs.find(tab => tab.id === activeTabId);

      // Only trigger navigation if the URL actually changed, NOT just loading state
      if (activeTab && previousTab && currentView && activeTab.url !== previousTab.url) {
        this.ensureViewNavigatedToTab(currentView, activeTab);
      }
    }
  }

  private async handleTabSwitch(windowId: string, newState: ClassicBrowserPayload, activeTabId?: string, currentView?: WebContentsView): Promise<void> {
    const previousTabId = this.findTabIdForView(currentView);
    this.logInfo(`[TAB SWITCH] Window ${windowId} switching from Tab ${previousTabId || 'none'} to Tab ${activeTabId || 'none'}`);
    
    if (currentView) {
      this.setViewState(currentView, false);
      this.views.delete(windowId);
    }

    if (activeTabId) {
      this.logInfo(`[TAB ACTIVATION] Activating Tab ${activeTabId} in Window ${windowId}`);
      const newView = await this.deps.globalTabPool.acquireView(activeTabId, windowId);
      this.views.set(windowId, newView);
      this.viewToTabMapping.set(newView, activeTabId);
      this.setViewState(newView, true, newState.bounds);

      const activeTab = newState.tabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const viewUrl = newView.webContents.getURL();
        const isBlankView = !viewUrl || viewUrl === 'about:blank' || viewUrl === '';
        
        this.logInfo(`[TAB STATE] Tab ${activeTabId} - Current URL: ${viewUrl || 'blank'}, Target URL: ${activeTab.url || 'none'}`);

        if (isBlankView && activeTab.url) {
          this.logInfo(`[TAB NAVIGATION] Tab ${activeTabId} is blank, navigating to ${activeTab.url}`);
          await this.ensureViewNavigatedToTab(newView, activeTab);
        } else if (!isBlankView) {
          this.logInfo(`[TAB READY] Tab ${activeTabId} already has content: ${viewUrl}`);
        }
      }
    }
  }

  private setViewState(view: WebContentsView, isAttached: boolean, bounds?: Electron.Rectangle): void {
    if (!this.deps.mainWindow || this.deps.mainWindow.isDestroyed()) return;

    const contentView = this.deps.mainWindow.contentView;
    const isCurrentlyAttached = contentView.children.includes(view);
    
    // Find the tab ID for this view for better logging
    const tabId = this.findTabIdForView(view) || 'unknown';

    if (isAttached && !isCurrentlyAttached) {
      this.logInfo(`[VIEW ATTACH] Attaching view for Tab ${tabId} to main window`);
      if (bounds) {
        view.setBounds(bounds);
        this.logInfo(`[VIEW BOUNDS] Tab ${tabId} bounds set to: ${JSON.stringify(bounds)}`);
      }
      contentView.addChildView(view);
      this.logInfo(`[VIEW ATTACHED] Tab ${tabId} successfully attached to window`);
    } else if (!isAttached && isCurrentlyAttached) {
      this.logInfo(`[VIEW DETACH] Detaching view for Tab ${tabId} from main window`);
      contentView.removeChildView(view);
      this.logInfo(`[VIEW DETACHED] Tab ${tabId} successfully detached from window`);
    } else {
      this.logDebug(`[VIEW STATE] Tab ${tabId} already in desired state (attached: ${isAttached})`);
    }
  }

  // Public method for IPC handlers to use
  public setViewVisibility(view: WebContentsView, isVisible: boolean): void {
    if (!view) return;
    
    // Use the setVisible method to hide/show the view
    view.setVisible(isVisible);
    
    // Log for debugging
    this.logDebug(`Set view visibility to ${isVisible} for view`);
  }
  
  // Get a view for a window
  public getViewForWindow(windowId: string): WebContentsView | undefined {
    return this.views.get(windowId);
  }

  private findTabIdForView(view?: WebContentsView): string | undefined {
    if (!view) {
      return undefined;
    }
    
    // Get the actual tab ID that this view represents from our mapping
    return this.viewToTabMapping.get(view);
  }

  private async handleWindowFocusChanged({ windowId, isFocused }: { windowId: string; isFocused: boolean }): Promise<void> {
    if (isFocused) {
      // When a window gains focus, ensure its view is on top
      const view = this.views.get(windowId);
      if (view) {
        this.bringViewToTop(view);
      }
    }
  }

  private async handleWindowMinimized({ windowId }: { windowId: string }): Promise<void> {
    const view = this.views.get(windowId);
    if (view) {
      // Just hide the view, don't detach it
      this.setViewVisibility(view, false);
      // View remains in map - we're using a single unified map now
      // Keep the view-to-tab mapping - it's still valid
    }
  }

  private async handleWindowRestored({ windowId, zIndex }: { windowId: string; zIndex: number }): Promise<void> {
    const view = this.views.get(windowId);
    if (view) {
      // View already in map (single unified map) - just show it again
      this.setViewVisibility(view, true);
      
      // Update bounds if needed
      const bounds = this.getBoundsForWindow(windowId);
      if (bounds) {
        view.setBounds(bounds);
      }
      
      // No need for ensureViewNavigatedToTab() - content is intact
    }
  }

  // LEGACY: This will be merged into unified state handler
  public async handleZOrderUpdate({ orderedWindows }: { orderedWindows: Array<{ windowId:string; zIndex: number; isFocused: boolean; isMinimized: boolean }> }): Promise<void> {
    // Re-attach all non-minimized views in correct z-order (lowest to highest)
    const activeWindowsInOrder = orderedWindows
      .filter(w => !w.isMinimized)
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const { windowId } of activeWindowsInOrder) {
      // Single unified map lookup - no need to check multiple maps
      const view = this.views.get(windowId);
      if (view) {
        this.bringViewToTop(view);
      }
    }
  }

  private bringViewToTop(view: WebContentsView): void {
    if (!this.deps.mainWindow || this.deps.mainWindow.isDestroyed()) return;
    
    const contentView = this.deps.mainWindow.contentView;
    const children = contentView.children;
    
    // Only re-add if the view is not already the topmost child
    if (children.includes(view)) {
      const isAlreadyOnTop = children[children.length - 1] === view;
      if (!isAlreadyOnTop) {
        // The only way to change z-order in Electron is to remove and re-add the view
        contentView.removeChildView(view);
        contentView.addChildView(view);
      }
    }
  }

  private getBoundsForWindow(windowId: string): Electron.Rectangle | null {
    // Get bounds from the browser state service
    const state = this.deps.stateService?.getState(windowId);
    if (state?.bounds) {
      return state.bounds;
    }
    
    // Fallback to default bounds
    return { x: 0, y: 0, width: 800, height: 600 };
  }

  private async ensureViewNavigatedToTab(view: WebContentsView, tab: TabState): Promise<void> {
    if (!tab.url || tab.url === 'about:blank') {
      this.logDebug(`[ENSURE NAV] Tab ${tab.id} has no URL to navigate to`);
      return; // No URL to navigate to
    }

    const currentUrl = view.webContents.getURL();
    const webContents = view.webContents;
    
    this.logInfo(`[ENSURE NAV] Tab ${tab.id} - Comparing current: ${currentUrl || 'blank'} with target: ${tab.url}`);
    
    // Improved URL comparison to handle dynamic sites like Google/Bing
    const urlsMatch = this.compareUrls(currentUrl, tab.url);
    
    if (urlsMatch) {
      this.logInfo(`[ENSURE NAV] Tab ${tab.id} URLs match, skipping navigation`);
      return;
    }
    
    // Additional checks to prevent unnecessary reloads:
    // 1. Skip if WebContents is already loading the target URL
    if (webContents.isLoading()) {
      const loadingUrl = webContents.getURL();
      if (this.compareUrls(loadingUrl, tab.url) || tab.isLoading) {
        return;
      }
    }
    
    // 2. Skip if this is a recent navigation (within 1 second) to prevent reload loops
    const lastNavigationTime = (view as ExtendedWebContentsView)._lastNavigationTime || 0;
    const now = Date.now();
    const timeSinceLastNav = now - lastNavigationTime;
    if (timeSinceLastNav < 1000) {
      return;
    }
    
    // Validate URL security before navigation
    if (isSecureUrl(tab.url, { context: 'tab-restoration' })) {
      try {
        (view as ExtendedWebContentsView)._lastNavigationTime = now;
        await view.webContents.loadURL(tab.url);
      } catch (error) {
        // Only log as error if it's not an abort (which might be expected)
        if (error instanceof Error && (error as ErrorWithCode).code === 'ERR_ABORTED') {
          this.logDebug(`Navigation aborted for ${tab.url} - likely handled by another service`);
        } else {
          this.logError(`Failed to navigate view to ${tab.url}:`, error);
        }
      }
    } else {
      this.logWarn(`Skipping navigation to insecure URL: ${tab.url}`);
    }
  }

  /**
   * Compare two URLs with tolerance for dynamic elements common in sites like Google/Bing
   */
  private compareUrls(url1: string, url2: string): boolean {
    if (!url1 || !url2) return url1 === url2;
    
    try {
      const u1 = new URL(url1);
      const u2 = new URL(url2);
      
      // Normalize hostnames to handle www differences
      const normalizeHostname = (hostname: string) => {
        return hostname.startsWith('www.') ? hostname.substring(4) : hostname;
      };
      
      const host1 = normalizeHostname(u1.hostname);
      const host2 = normalizeHostname(u2.hostname);
      
      // Different hosts are definitely different
      if (host1 !== host2) return false;
      
      // Different protocols are different (unless both are http/https)
      if (u1.protocol !== u2.protocol) {
        const isHttpVariant = (protocol: string) => protocol === 'http:' || protocol === 'https:';
        if (!(isHttpVariant(u1.protocol) && isHttpVariant(u2.protocol))) {
          return false;
        }
      }
      
      // Same pathname (ignoring trailing slashes)
      const path1 = u1.pathname.replace(/\/$/, '') || '/';
      const path2 = u2.pathname.replace(/\/$/, '') || '/';
      if (path1 !== path2) return false;
      
      // For search engines and dynamic sites, consider URLs the same if the main query is similar
      if (this.isSearchEngineUrl(u1) || this.isSearchEngineUrl(u2)) {
        return this.compareSearchUrls(u1, u2);
      }
      
      // For other sites, do basic query parameter comparison (ignoring tracking params)
      return this.compareQueryParams(u1.searchParams, u2.searchParams);
    } catch {
      // If URL parsing fails, fall back to simple string comparison with normalization
      const normalize = (url: string) => {
        return url
          .replace(/^https?:\/\/(www\.)?/, 'https://') // Normalize protocol and www
          .replace(/\/$/, '') // Remove trailing slash
          .toLowerCase();
      };
      return normalize(url1) === normalize(url2);
    }
  }

  private isSearchEngineUrl(url: URL): boolean {
    const searchDomains = ['google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com'];
    return searchDomains.some(domain => url.hostname.includes(domain));
  }

  private compareSearchUrls(u1: URL, u2: URL): boolean {
    // For search engines, consider URLs the same if they have the same main search query
    const q1 = u1.searchParams.get('q') || u1.searchParams.get('query') || '';
    const q2 = u2.searchParams.get('q') || u2.searchParams.get('query') || '';
    return q1 === q2;
  }

  private compareQueryParams(params1: URLSearchParams, params2: URLSearchParams): boolean {
    // Ignore common tracking and session parameters
    const ignoredParams = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'msclkid', '_ga', '_gid', 'sessionid', 'timestamp',
      'source', 'ref', 'referer', 'referrer'
    ]);
    
    const getFilteredParams = (params: URLSearchParams) => {
      const filtered = new URLSearchParams();
      for (const [key, value] of params.entries()) {
        if (!ignoredParams.has(key.toLowerCase())) {
          filtered.append(key, value);
        }
      }
      return filtered;
    };
    
    const filtered1 = getFilteredParams(params1);
    const filtered2 = getFilteredParams(params2);
    
    return filtered1.toString() === filtered2.toString();
  }

  async cleanup(): Promise<void> {
    this.deps.eventBus.removeAllListeners('state-changed');
    this.deps.eventBus.removeAllListeners('window:focus-changed');
    this.deps.eventBus.removeAllListeners('window:minimized');
    this.deps.eventBus.removeAllListeners('window:restored');
    this.deps.eventBus.removeAllListeners('window:z-order-update');
    
    // Clean up all overlay views
    for (const [windowId, overlay] of this.overlayViews.entries()) {
      try {
        if (overlay.webContents && !overlay.webContents.isDestroyed()) {
          (overlay.webContents as any).destroy();
        }
      } catch (error) {
        this.logError(`Error destroying overlay for ${windowId}:`, error);
      }
    }
    
    // Clear overlay timeouts
    for (const timeout of this.overlayTimeouts.values()) {
      clearTimeout(timeout);
    }
    
    this.views.forEach(view => this.setViewState(view, false));
    this.views.clear();
    this.viewToTabMapping.clear();
    this.overlayViews.clear();
    this.overlayTimeouts.clear();
    this.overlayReadyPromises.clear();
    this.activeOverlayWindowIds.clear();
  }

  // Missing methods that IPC handlers expect
  public async releaseView(tabId: string): Promise<void> {
    return this.deps.globalTabPool.releaseView(tabId);
  }

  public getView(tabId: string): WebContentsView | undefined {
    return this.deps.globalTabPool.getView(tabId);
  }

  /**
   * Show the context menu overlay at the specified position
   */
  public async showContextMenuOverlay(windowId: string, contextData: BrowserContextMenuData): Promise<void> {
    return this.execute('showContextMenuOverlay', async () => {
      this.logInfo(`[showContextMenuOverlay] Starting for windowId: ${windowId} at position (${contextData.x}, ${contextData.y})`);
      this.logDebug(`[showContextMenuOverlay] Full context data:`, JSON.stringify(contextData, null, 2));

      // Hide any existing overlays for other windows
      for (const activeWindowId of this.activeOverlayWindowIds) {
        if (activeWindowId !== windowId) {
          this.hideContextMenuOverlay(activeWindowId);
        }
      }

      // Get or create the overlay view
      let overlay = this.overlayViews.get(windowId);
      if (!overlay || overlay.webContents.isDestroyed()) {
        this.logInfo(`[showContextMenuOverlay] Creating new overlay for windowId: ${windowId}`);
        overlay = this.createOverlayView(windowId);
        this.overlayViews.set(windowId, overlay);
      } else {
        this.logInfo(`[showContextMenuOverlay] Reusing existing overlay for windowId: ${windowId}`);
      }

      // Clear any existing timeout for this overlay
      const existingTimeout = this.overlayTimeouts.get(windowId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.overlayTimeouts.delete(windowId);
      }

      // Add the overlay to the main window
      if (!this.deps.mainWindow.contentView.children.includes(overlay)) {
        this.deps.mainWindow.contentView.addChildView(overlay);
      }

      // Position the overlay at the cursor location
      // The overlay will be full window size, but the menu itself will be positioned via CSS
      const windowBounds = this.deps.mainWindow.getBounds();
      overlay.setBounds({
        x: 0,
        y: 0,
        width: windowBounds.width,
        height: windowBounds.height
      });

      // Ensure the overlay is on top by re-adding it last
      // This is a simple way to ensure it's above all browser views
      if (this.deps.mainWindow.contentView.children.includes(overlay)) {
        this.deps.mainWindow.contentView.removeChildView(overlay);
        this.deps.mainWindow.contentView.addChildView(overlay);
      }

      // Wait for the overlay to be ready before sending context data
      const readyPromise = this.overlayReadyPromises.get(windowId);
      if (readyPromise) {
        this.logInfo(`[showContextMenuOverlay] Waiting for overlay to be ready...`);
        await readyPromise.promise;
        this.logInfo(`[showContextMenuOverlay] Overlay is ready, sending context data`);
      } else {
        this.logWarn(`[showContextMenuOverlay] No ready promise found for windowId: ${windowId}, sending immediately`);
      }

      // Send the context data to the overlay
      this.logInfo(`[showContextMenuOverlay] Sending context data to overlay via IPC channel: ${BROWSER_CONTEXT_MENU_SHOW}`);
      overlay.webContents.send(BROWSER_CONTEXT_MENU_SHOW, contextData);

      this.activeOverlayWindowIds.add(windowId);
      this.logInfo(`[showContextMenuOverlay] Context menu overlay shown successfully`);
    });
  }

  /**
   * Hide the context menu overlay
   */
  public hideContextMenuOverlay(windowId: string): void {
    this.logDebug(`Hiding context menu overlay for windowId: ${windowId}`);

    const overlay = this.overlayViews.get(windowId);
    if (!overlay || overlay.webContents.isDestroyed()) {
      return;
    }

    // Remove from the main window
    if (this.deps.mainWindow.contentView.children.includes(overlay)) {
      this.deps.mainWindow.contentView.removeChildView(overlay);
    }

    // Note: We don't send hide events to the overlay to avoid circular loops
    // The overlay manages its own lifecycle and notifies us when it's done

    // Set a timeout to destroy the overlay if it's not reused
    const timeout = setTimeout(() => {
      this.destroyOverlay(windowId);
    }, 5000); // 5 seconds

    this.overlayTimeouts.set(windowId, timeout);

    this.activeOverlayWindowIds.delete(windowId);
  }

  /**
   * Handle overlay ready notification
   */
  public handleOverlayReady(webContents: Electron.WebContents): void {
    // Find which overlay this webContents belongs to
    for (const [windowId, overlay] of this.overlayViews.entries()) {
      if (overlay.webContents === webContents) {
        this.logInfo(`[handleOverlayReady] Overlay ready for windowId: ${windowId}`);
        const readyPromise = this.overlayReadyPromises.get(windowId);
        if (readyPromise) {
          readyPromise.resolve();
          this.logDebug(`[handleOverlayReady] Resolved ready promise for windowId: ${windowId}`);
        }
        return;
      }
    }
    this.logWarn(`[handleOverlayReady] Could not find overlay for webContents`);
  }

  /**
   * Create an overlay WebContentsView for context menus
   */
  private createOverlayView(windowId: string): WebContentsView {
    // Create a promise to track when the overlay is ready
    let readyResolve: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    this.overlayReadyPromises.set(windowId, { promise: readyPromise, resolve: readyResolve! });
    this.logInfo(`[createOverlayView] Creating overlay view for windowId: ${windowId}`);
    
    // Use app.getAppPath() for consistent path resolution
    const appPath = app.getAppPath();
    const preloadPath = path.join(appPath, 'dist', 'electron', 'preload.js');
    
    // Log for debugging
    this.logDebug(`[createOverlayView] App path: ${appPath}`);
    this.logDebug(`[createOverlayView] Preload path: ${preloadPath}`);
    this.logDebug(`[createOverlayView] Preload exists: ${require('fs').existsSync(preloadPath)}`);
    
    const overlay = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        transparent: true,
        webSecurity: false  // Disable web security for overlay to allow file:// URLs
      }
    });

    // Set transparent background
    overlay.setBackgroundColor('#00000000');
    // Note: setAutoResize was removed in newer Electron versions
    // The overlay will be manually resized when needed

    // Load dedicated overlay HTML without query parameters first
    const baseUrl = this.getAppURL();
    const overlayUrl = `${baseUrl}/overlay.html`;
    this.logInfo(`[createOverlayView] Base URL: ${baseUrl}`);
    this.logInfo(`[createOverlayView] Loading overlay URL: ${overlayUrl}`);
    
    // Load the HTML file first, then inject the windowId via IPC
    overlay.webContents.loadURL(overlayUrl).then(() => {
      this.logInfo(`[createOverlayView] Successfully loaded overlay, will inject windowId: ${windowId}`);
      // We'll send the windowId after the page loads
    }).catch((error) => {
      this.logError(`[createOverlayView] Failed to load overlay: ${error}`);
    });

    // Setup overlay-specific listeners
    this.setupOverlayListeners(overlay, windowId);

    return overlay;
  }

  /**
   * Get the app URL based on environment
   */
  private getAppURL(): string {
    const { app } = require('electron');
    const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
    
    if (isDev) {
      const nextDevServerUrl = process.env.NEXT_DEV_SERVER_URL || 'http://localhost:3000';
      this.logInfo(`[getAppURL] Development mode - using URL: ${nextDevServerUrl}`);
      return nextDevServerUrl;
    } else {
      // For packaged apps, the overlay files are extracted to Resources directory
      // not inside the asar archive
      const resourcesPath = process.resourcesPath;
      const outPath = path.join(resourcesPath, 'app.asar.unpacked', 'out');
      // Ensure proper file URL format with forward slashes
      const normalizedPath = outPath.replace(/\\/g, '/');
      const resultUrl = `file:///${normalizedPath}`;
      this.logInfo(`[getAppURL] Production mode - resourcesPath: ${resourcesPath}, outPath: ${outPath}, normalizedPath: ${normalizedPath}, resultUrl: ${resultUrl}`);
      
      // Additional debugging: check if files exist
      const fs = require('fs');
      const overlayPath = path.join(outPath, 'overlay.html');
      const overlayJsPath = path.join(outPath, 'overlay.js');
      this.logInfo(`[getAppURL] Checking file existence:`);
      this.logInfo(`[getAppURL] overlay.html exists: ${fs.existsSync(overlayPath)}`);
      this.logInfo(`[getAppURL] overlay.js exists: ${fs.existsSync(overlayJsPath)}`);
      
      return resultUrl;
    }
  }

  /**
   * Set up listeners for the overlay WebContentsView
   */
  private setupOverlayListeners(overlay: WebContentsView, windowId: string): void {
    const wc = overlay.webContents;

    // Listen for when the overlay is ready
    wc.once('dom-ready', () => {
      this.logInfo(`[setupOverlayListeners] Overlay DOM ready for windowId: ${windowId}`);
      // Send windowId to overlay after DOM is ready
      wc.executeJavaScript(`
        if (window.overlayInstance) {
          window.overlayInstance.setWindowId('${windowId}');
          true;
        } else {
          false;
        }
      `).then((result) => {
        if (!result) {
          this.logError('[Overlay] overlayInstance not found on window');
        }
      }).catch((error) => {
        this.logError(`[setupOverlayListeners] Failed to set windowId: ${error}`);
      });
    });


    // Add console message logging for debugging
    wc.on('console-message', (event, level, message, line, sourceId) => {
      this.logInfo(`[Overlay Console] ${message} (line ${line} in ${sourceId})`);
    });

    // Handle navigation prevention (overlays should not navigate)
    wc.on('will-navigate', (event) => {
      event.preventDefault();
      this.logWarn(`Prevented navigation in overlay for windowId: ${windowId}`);
    });

    // Handle overlay crashes
    wc.on('render-process-gone', (_event, details) => {
      this.logError(`Overlay render process gone for windowId ${windowId}:`, details);
      // Clean up the crashed overlay
      this.overlayViews.delete(windowId);
    });

    // Log errors
    wc.on('did-fail-load', (_event, errorCode, errorDescription) => {
      this.logError(`Overlay failed to load for windowId ${windowId}: ${errorDescription} (${errorCode})`);
    });

    // Auto-hide overlay when it loses focus (user clicked elsewhere)
    wc.on('blur', () => {
      this.logDebug(`Overlay lost focus for windowId: ${windowId}`);
      // Only hide if this is still an active overlay
      if (this.activeOverlayWindowIds.has(windowId)) {
        this.hideContextMenuOverlay(windowId);
      }
    });
  }

  /**
   * Destroy an overlay view and clean up resources
   */
  private destroyOverlay(windowId: string): void {
    this.logDebug(`Destroying overlay for windowId: ${windowId}`);

    const overlay = this.overlayViews.get(windowId);
    if (!overlay) {
      return;
    }

    // Clear any timeout
    const timeout = this.overlayTimeouts.get(windowId);
    if (timeout) {
      clearTimeout(timeout);
      this.overlayTimeouts.delete(windowId);
    }

    // Remove from main window if still attached
    if (!overlay.webContents.isDestroyed() && this.deps.mainWindow.contentView.children.includes(overlay)) {
      this.deps.mainWindow.contentView.removeChildView(overlay);
    }

    // Destroy the webContents
    try {
      if (!overlay.webContents.isDestroyed()) {
        (overlay.webContents as any).destroy();
      }
    } catch (error) {
      this.logError(`Error destroying overlay webContents for ${windowId}:`, error);
    }

    // Remove from maps
    this.overlayViews.delete(windowId);
    this.activeOverlayWindowIds.delete(windowId);
    this.overlayReadyPromises.delete(windowId);
  }

  /**
   * Clean up all views and state for a specific window
   */
  public async cleanupWindow(windowId: string): Promise<void> {
    // Detach any active view from the main window
    const currentView = this.views.get(windowId);
    if (currentView) {
      this.setViewState(currentView, false);
      this.views.delete(windowId);
      // Keep the view-to-tab mapping - the view might be reused by other windows
    }
    
    // Remove any minimized view
    const minimizedView = this.views.get(windowId);
    if (minimizedView) {
      this.setViewState(minimizedView, false);
      // View already in map, no need to move
      // Keep the view-to-tab mapping - the view might be reused by other windows
    }
    
    // Remove any frozen view
    const frozenView = this.views.get(windowId);
    if (frozenView) {
      this.setViewState(frozenView, false);
      // View already in map, no need to move
      // Keep the view-to-tab mapping - the view might be reused by other windows
    }
    
    // Clean up window mappings in the global tab pool
    this.deps.globalTabPool.cleanupWindowMappings(windowId);
    
    // Also destroy any associated overlay
    this.destroyOverlay(windowId);
  }
}
