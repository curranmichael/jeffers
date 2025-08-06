
import { BrowserWindow, WebContentsView } from 'electron';
import { BaseService } from '../base/BaseService';
import { ClassicBrowserPayload, TabState } from '../../shared/types';
import { BrowserEventBus } from './BrowserEventBus';
import { GlobalTabPool } from './GlobalTabPool';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { isSecureUrl } from '../../utils/urlSecurity';

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
  private activeViews: Map<string, WebContentsView> = new Map(); // windowId -> view
  private detachedViews: Map<string, WebContentsView> = new Map(); // windowId -> view (for minimized windows)
  private frozenViews: Map<string, WebContentsView> = new Map(); // windowId -> view (for frozen windows)
  private viewToTabMapping: Map<WebContentsView, string> = new Map(); // view -> tabId

  constructor(deps: ClassicBrowserViewManagerDeps) {
    super('ClassicBrowserViewManager', deps);
  }

  async initialize(): Promise<void> {
    this.deps.eventBus.on('state-changed', this.handleStateChange.bind(this));
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
      // Hide the view but keep it attached for z-index management
      const currentView = this.activeViews.get(windowId);
      if (currentView) {
        // Hide the view but keep it attached
        this.setViewVisibility(currentView, false);
        // Move from active to frozen
        this.frozenViews.set(windowId, currentView);
        this.activeViews.delete(windowId);
      }
      return; // Skip normal tab handling when frozen
    }

    // Handle transition from frozen to active
    if (previousState?.freezeState?.type === 'FROZEN' &&
        newState.freezeState?.type === 'ACTIVE') {
      // Check if we have a frozen view to restore
      const frozenView = this.frozenViews.get(windowId);
      if (frozenView) {
        // Move from frozen back to active
        this.frozenViews.delete(windowId);
        this.activeViews.set(windowId, frozenView);
        // Make the view visible again
        this.setViewVisibility(frozenView, true);
        // Update bounds if needed
        if (newState.bounds) {
          frozenView.setBounds(newState.bounds);
        }
        
        // Ensure the view is navigated to the correct URL
        if (newState.activeTabId) {
          const activeTab = newState.tabs.find(tab => tab.id === newState.activeTabId);
          if (activeTab) {
            await this.ensureViewNavigatedToTab(frozenView, activeTab);
          }
        }
      } else if (newState.activeTabId) {
        // Fallback: Re-acquire view if we don't have a frozen one
        const view = await this.deps.globalTabPool.acquireView(newState.activeTabId, windowId);
        this.activeViews.set(windowId, view);
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
    const currentView = this.activeViews.get(windowId);
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
    const currentView = this.activeViews.get(windowId);

    if (currentView && newState.bounds) {
      currentView.setBounds(newState.bounds);
    }

    if (isNavigationRelevant && previousState && previousState.activeTabId === activeTabId) {
      const activeTab = newState.tabs.find(tab => tab.id === activeTabId);
      const previousTab = previousState.tabs.find(tab => tab.id === activeTabId);

      if (activeTab && previousTab && currentView &&
          (activeTab.url !== previousTab.url || activeTab.isLoading !== previousTab.isLoading)) {
        this.ensureViewNavigatedToTab(currentView, activeTab);
      }
    }
  }

  private async handleTabSwitch(windowId: string, newState: ClassicBrowserPayload, activeTabId?: string, currentView?: WebContentsView): Promise<void> {
    if (currentView) {
      this.setViewState(currentView, false);
      this.activeViews.delete(windowId);
    }

    if (activeTabId) {
      const newView = await this.deps.globalTabPool.acquireView(activeTabId, windowId);
      this.activeViews.set(windowId, newView);
      this.viewToTabMapping.set(newView, activeTabId);
      this.setViewState(newView, true, newState.bounds);

      const activeTab = newState.tabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const viewUrl = newView.webContents.getURL();
        const isBlankView = !viewUrl || viewUrl === 'about:blank' || viewUrl === '';

        if (isBlankView) {
          await this.ensureViewNavigatedToTab(newView, activeTab);
        }
      }
    }
  }

  private setViewState(view: WebContentsView, isAttached: boolean, bounds?: Electron.Rectangle): void {
    if (!this.deps.mainWindow || this.deps.mainWindow.isDestroyed()) return;

    const contentView = this.deps.mainWindow.contentView;
    const isCurrentlyAttached = contentView.children.includes(view);

    if (isAttached && !isCurrentlyAttached) {
      if (bounds) {
        view.setBounds(bounds);
      }
      contentView.addChildView(view);
    } else if (!isAttached && isCurrentlyAttached) {
      contentView.removeChildView(view);
    }
  }

  private setViewVisibility(view: WebContentsView, isVisible: boolean): void {
    if (!view) return;
    
    // Use the setVisible method to hide/show the view
    view.setVisible(isVisible);
    
    // Log for debugging
    this.logDebug(`Set view visibility to ${isVisible} for view`);
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
      const view = this.activeViews.get(windowId);
      if (view) {
        this.bringViewToTop(view);
      }
    }
  }

  private async handleWindowMinimized({ windowId }: { windowId: string }): Promise<void> {
    const view = this.activeViews.get(windowId);
    if (view) {
      // Detach the view from the main window and store it
      this.setViewState(view, false);
      this.detachedViews.set(windowId, view);
      this.activeViews.delete(windowId);
      // Keep the view-to-tab mapping - it's still valid
    }
  }

  private async handleWindowRestored({ windowId, zIndex }: { windowId: string; zIndex: number }): Promise<void> {
    const view = this.detachedViews.get(windowId);
    if (view) {
      // Move view back to active views
      this.detachedViews.delete(windowId);
      this.activeViews.set(windowId, view);
      
      // Get the current state for restoration
      const state = this.deps.stateService.getState(windowId);
      
      // Re-attach the view - it will be positioned correctly by z-order update
      const bounds = this.getBoundsForWindow(windowId);
      if (bounds) {
        this.setViewState(view, true, bounds);
      }
      
      // Ensure the view navigates to the correct URL for the active tab
      if (state && state.activeTabId) {
        const activeTab = state.tabs.find(tab => tab.id === state.activeTabId);
        if (activeTab) {
          await this.ensureViewNavigatedToTab(view, activeTab);
        }
      }
    }
  }

  public async handleZOrderUpdate({ orderedWindows }: { orderedWindows: Array<{ windowId:string; zIndex: number; isFocused: boolean; isMinimized: boolean }> }): Promise<void> {
    // Re-attach all non-minimized views in correct z-order (lowest to highest)
    const activeWindowsInOrder = orderedWindows
      .filter(w => !w.isMinimized)
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const { windowId } of activeWindowsInOrder) {
      // Check both active and frozen views for z-index management
      const view = this.activeViews.get(windowId) || this.frozenViews.get(windowId);
      if (view) {
        this.bringViewToTop(view);
      }
    }
  }

  private bringViewToTop(view: WebContentsView): void {
    if (!this.deps.mainWindow || this.deps.mainWindow.isDestroyed()) return;
    
    // The only way to change z-order in Electron is to remove and re-add the view
    if (this.deps.mainWindow.contentView.children.includes(view)) {
      this.deps.mainWindow.contentView.removeChildView(view);
      this.deps.mainWindow.contentView.addChildView(view);
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
      return; // No URL to navigate to
    }

    const currentUrl = view.webContents.getURL();
    const webContents = view.webContents;
    
    // Improved URL comparison to handle dynamic sites like Google/Bing
    const urlsMatch = this.compareUrls(currentUrl, tab.url);
    
    if (urlsMatch) {
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
    const lastNavigationTime = (view as any)._lastNavigationTime || 0;
    const now = Date.now();
    const timeSinceLastNav = now - lastNavigationTime;
    if (timeSinceLastNav < 1000) {
      return;
    }
    
    // Validate URL security before navigation
    if (isSecureUrl(tab.url, { context: 'tab-restoration' })) {
      try {
        (view as any)._lastNavigationTime = now;
        await view.webContents.loadURL(tab.url);
      } catch (error) {
        // Only log as error if it's not an abort (which might be expected)
        if (error instanceof Error && (error as any).code === 'ERR_ABORTED') {
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
    
    this.activeViews.forEach(view => this.setViewState(view, false));
    this.detachedViews.forEach(view => this.setViewState(view, false));
    this.frozenViews.forEach(view => this.setViewState(view, false));
    this.activeViews.clear();
    this.detachedViews.clear();
    this.frozenViews.clear();
    this.viewToTabMapping.clear();
  }

  // Missing methods that IPC handlers expect
  public async releaseView(tabId: string): Promise<void> {
    return this.deps.globalTabPool.releaseView(tabId);
  }

  public getView(tabId: string): WebContentsView | undefined {
    return this.deps.globalTabPool.getView(tabId);
  }

  public async showContextMenuOverlay(windowId: string, data: any): Promise<void> {
    // Handle context menu overlay display
  }

  public hideContextMenuOverlay(windowId: string): void {
    // Handle context menu overlay hide
  }

  public handleOverlayReady(windowId: string): void {
    // Handle overlay ready event
  }

  /**
   * Clean up all views and state for a specific window
   */
  public async cleanupWindow(windowId: string): Promise<void> {
    // Detach any active view from the main window
    const currentView = this.activeViews.get(windowId);
    if (currentView) {
      this.setViewState(currentView, false);
      this.activeViews.delete(windowId);
      // Keep the view-to-tab mapping - the view might be reused by other windows
    }
    
    // Remove any detached view
    const detachedView = this.detachedViews.get(windowId);
    if (detachedView) {
      this.detachedViews.delete(windowId);
      // Keep the view-to-tab mapping - the view might be reused by other windows
    }
    
    // Remove any frozen view
    const frozenView = this.frozenViews.get(windowId);
    if (frozenView) {
      this.setViewState(frozenView, false);
      this.frozenViews.delete(windowId);
      // Keep the view-to-tab mapping - the view might be reused by other windows
    }
  }
}
