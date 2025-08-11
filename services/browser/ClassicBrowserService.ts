
import { BrowserWindow, HandlerDetails } from 'electron';
import { BaseService } from '../base/BaseService';
import { ClassicBrowserPayload, TabState, BrowserActionData } from '../../shared/types';
import { BrowserContextMenuData } from '../../shared/types/contextMenu.types';
import { ClassicBrowserViewManager } from './ClassicBrowserViewManager';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { ClassicBrowserNavigationService } from './ClassicBrowserNavigationService';
import { ClassicBrowserTabService } from './ClassicBrowserTabService';
import { ClassicBrowserWOMService } from './ClassicBrowserWOMService';
import { ClassicBrowserSnapshotService } from './ClassicBrowserSnapshotService';
import { GlobalTabPool } from './GlobalTabPool';

export interface ClassicBrowserServiceDeps {
  mainWindow: BrowserWindow;
  viewManager: ClassicBrowserViewManager;
  stateService: ClassicBrowserStateService;
  navigationService: ClassicBrowserNavigationService;
  tabService: ClassicBrowserTabService;
  womService: ClassicBrowserWOMService;
  snapshotService: ClassicBrowserSnapshotService;
  globalTabPool: GlobalTabPool;
}

/**
 * The main entry point for all browser-related operations.
 * Delegates to other services to handle the actual logic.
 */
export class ClassicBrowserService extends BaseService<ClassicBrowserServiceDeps> {
  constructor(deps: ClassicBrowserServiceDeps) {
    super('ClassicBrowserService', deps);
  }

  async initialize(): Promise<void> {
    // Set up event listeners for tab metadata updates from WebContents
    const eventBus = this.deps.stateService.getEventBus();
    
    // Listen for title updates and update the correct tab
    eventBus.on('view:page-title-updated', ({ windowId, title, tabId }) => {
      // this.logInfo(`[TITLE RECEIVED] Window ${windowId}, tab ${tabId || 'UNSPECIFIED'}: "${title}"`);
      
      // Use the specific tabId if provided, otherwise use the active tab
      let targetTabId = tabId;
      if (!targetTabId) {
        const state = this.deps.stateService.getState(windowId);
        targetTabId = state?.activeTabId;
        // this.logInfo(`[TITLE PROCESSING] No tabId provided, using activeTabId: ${targetTabId || 'NONE'}`);
      }
      
      if (targetTabId) {
        // this.logInfo(`[TITLE UPDATING] Updating tab ${targetTabId} title to: "${title}"`);
        this.deps.stateService.updateTab(windowId, targetTabId, { title });
      } else {
        // this.logWarn(`[TITLE SKIPPED] No target tab for window ${windowId}`);
      }
    });

    // Listen for favicon updates and update the correct tab
    eventBus.on('view:page-favicon-updated', ({ windowId, faviconUrl, tabId }) => {
      // this.logInfo(`[FAVICON RECEIVED] Window ${windowId}, tab ${tabId || 'UNSPECIFIED'}: ${faviconUrl.length} favicons`);
      const favicon = faviconUrl.length > 0 ? faviconUrl[0] : null;
      
      // Use the specific tabId if provided, otherwise use the active tab
      let targetTabId = tabId;
      if (!targetTabId) {
        const state = this.deps.stateService.getState(windowId);
        targetTabId = state?.activeTabId;
        // this.logInfo(`[FAVICON PROCESSING] No tabId provided, using activeTabId: ${targetTabId || 'NONE'}`);
      }
      
      if (targetTabId) {
        // this.logInfo(`[FAVICON UPDATING] Updating tab ${targetTabId} favicon to: ${favicon}`);
        this.deps.stateService.updateTab(windowId, targetTabId, { faviconUrl: favicon });
      } else {
        // this.logWarn(`[FAVICON SKIPPED] No target tab for window ${windowId}`);
      }
    });

    // Listen for tab group title updates from enrichment service
    eventBus.on('tabgroup:title-updated', ({ windowId, title }) => {
      this.logInfo(`Tab group title updated for window ${windowId}: "${title}"`);
      const state = this.deps.stateService.getState(windowId);
      if (state) {
        this.deps.stateService.setState(windowId, { ...state, tabGroupTitle: title });
      }
    });

    // Listen for window open requests (CMD+click, middle-click, etc.)
    eventBus.on('view:window-open-request', ({ windowId, details }) => {
      this.handleWindowOpenRequest(windowId, details);
    });

    // Listen for tab:new events (from context menu "open in new tab")
    eventBus.on('tab:new', async ({ windowId, url }) => {
      this.logDebug(`Creating new background tab for window ${windowId}: ${url}`);
      try {
        // Always create as background tab (makeActive = false)
        const tabId = this.deps.tabService.createTab(windowId, url, false);
        // Check if we need to create a tab group after initialization
        await this.deps.womService.checkAndCreateTabGroup(windowId);
        this.logInfo(`Created background tab ${tabId} for URL: ${url}`);
        
        // Immediately acquire view and load URL for background tabs
        // This ensures title/favicon events fire from the actual WebContentsView
        if (url) {
          this.loadBackgroundTab(tabId, windowId, url);
        }
      } catch (err) {
        this.logError(`Failed to create new tab from context menu:`, err);
      }
    });

    // Listen for context menu requests and show the overlay
    eventBus.on('view:context-menu-requested', async (eventData) => {
      const { windowId, params, viewBounds } = eventData;
      this.logDebug(`Received context menu request for window ${windowId} at (${params.x}, ${params.y})`);
      
      // Get the current browser state for navigation info
      const state = this.deps.stateService.getState(windowId);
      if (!state) {
        this.logWarn(`No state found for windowId ${windowId}, cannot show context menu`);
        return;
      }
      
      // Transform the parameters to BrowserContextMenuData format
      // Note: params.x and params.y are relative to the WebContentsView
      // We need to transform them to window coordinates by adding the view's position
      const contextData = {
        windowId,
        x: params.x + viewBounds.x,
        y: params.y + viewBounds.y,
        contextType: 'browser' as const,
        viewBounds,
        browserContext: {
          linkURL: params.linkURL || '',
          srcURL: params.srcURL || '',
          pageURL: params.pageURL || state.tabs.find(t => t.id === state.activeTabId)?.url || '',
          frameURL: params.frameURL || '',
          selectionText: params.selectionText || '',
          isEditable: params.isEditable || false,
          canGoBack: state.tabs.find(t => t.id === state.activeTabId)?.canGoBack || false,
          canGoForward: state.tabs.find(t => t.id === state.activeTabId)?.canGoForward || false,
          canReload: true,
          canViewSource: true,
          mediaType: params.mediaType as 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin' | undefined,
          hasImageContents: params.hasImageContents || false,
          editFlags: {
            canUndo: params.editFlags?.canUndo || false,
            canRedo: params.editFlags?.canRedo || false,
            canCut: params.editFlags?.canCut || false,
            canCopy: params.editFlags?.canCopy || false,
            canPaste: params.editFlags?.canPaste || false,
            canSelectAll: params.editFlags?.canSelectAll || false,
          }
        }
      };
      
      // Show the context menu overlay
      await this.deps.viewManager.showContextMenuOverlay(windowId, contextData);
    });
  }

  

  async cleanup(): Promise<void> {
    // Remove event listeners
    const eventBus = this.deps.stateService.getEventBus();
    eventBus.removeAllListeners('view:page-title-updated');
    eventBus.removeAllListeners('view:page-favicon-updated');
    eventBus.removeAllListeners('view:context-menu-requested');
    eventBus.removeAllListeners('view:window-open-request');
    eventBus.removeAllListeners('tab:new');
    eventBus.removeAllListeners('tabgroup:title-updated');
    await super.cleanup();
  }

  public createBrowserView(windowId: string, bounds: Electron.Rectangle, payload: ClassicBrowserPayload, notebookId?: string): void {
    this.logInfo(`[CREATE BROWSER] Creating browser view for Window ${windowId}`);
    this.logInfo(`[CREATE BROWSER] Initial state: ${payload.tabs.length} tabs, active: ${payload.activeTabId}`);
    
    // Log tab details
    payload.tabs.forEach(tab => {
      this.logInfo(`[TAB INIT] Tab ${tab.id}: ${tab.url || 'no-url'} (${tab.title || 'untitled'})`);
    });
    
    // Idempotency check: Skip if browser view already exists for this window
    const existingState = this.deps.stateService.getState(windowId);
    if (existingState) {
      this.logDebug(`[CREATE BROWSER] Browser view already exists for window ${windowId}, skipping duplicate creation`);
      return;
    }

    const initialState = { 
      ...payload, 
      bounds,
      // Ensure freezeState is always set, default to ACTIVE
      freezeState: payload.freezeState || { type: 'ACTIVE' }
    };
    
    this.logInfo(`[STATE INIT] Setting initial state for Window ${windowId}`);
    this.deps.stateService.setState(windowId, initialState);
    
    // Associate the browser window with a notebook if provided
    if (notebookId) {
      this.logInfo(`[NOTEBOOK ASSOC] Associating Window ${windowId} with Notebook ${notebookId}`);
      this.deps.womService.setWindowNotebook(windowId, notebookId);
    }
    
    // Ensure there's always at least one tab when creating a browser window
    if (!initialState.tabs.length || !initialState.activeTabId) {
      this.logInfo(`[CREATE TAB] No tabs found, creating default tab`);
      this.deps.tabService.createTab(windowId, 'https://www.are.na');
      // Check if we need to create a tab group after initialization
      this.deps.womService.checkAndCreateTabGroup(windowId).catch(err =>
        this.logError(`Failed to check/create tab group during init: ${err}`, err)
      );
    }
    
    this.logInfo(`[CREATE BROWSER] Browser view creation complete for Window ${windowId}`);
  }

  public async createTab(windowId: string, url?: string): Promise<string> {
    const tabId = this.deps.tabService.createTab(windowId, url);
    // Check if we need to create a tab group (when 2+ tabs exist)
    await this.deps.womService.checkAndCreateTabGroup(windowId);
    return tabId;
  }

  public switchTab(windowId: string, tabId: string): void {
    this.deps.tabService.switchTab(windowId, tabId);
  }

  public closeTab(windowId: string, tabId: string): void {
    this.deps.tabService.closeTab(windowId, tabId);
  }

  public loadUrl(windowId: string, url: string): Promise<void> {
    return this.deps.navigationService.loadUrl(windowId, url);
  }

  /**
   * Handles window open requests from webContents (CMD+click, middle-click, etc.)
   * This is called when a link tries to open in a new window/tab
   */
  private handleWindowOpenRequest(windowId: string, details: HandlerDetails): void {
    this.logDebug(`Window open request for window ${windowId}:`, details);
    
    // Check if this is a tab-related disposition
    const isTabRequest = details.disposition === 'foreground-tab' || 
                        details.disposition === 'background-tab';
    
    if (isTabRequest) {
      const makeActive = details.disposition === 'foreground-tab';
      this.logInfo(`Creating ${makeActive ? 'active' : 'background'} tab for ${details.url}`);
      
      try {
        // Create the new tab with the appropriate active state
        const tabId = this.deps.tabService.createTab(windowId, details.url, makeActive);
        // Check for tab group creation after adding new tab
        this.deps.womService.checkAndCreateTabGroup(windowId).catch(err => 
          this.logError(`Failed to check/create tab group: ${err}`, err)
        );
        this.logDebug(`Created tab ${tabId} as ${makeActive ? 'active' : 'background'}`);
        
        // For background tabs, immediately acquire view and load URL
        // This ensures title/favicon events fire from the actual WebContentsView
        if (!makeActive && details.url) {
          this.loadBackgroundTab(tabId, windowId, details.url);
        }
      } catch (err) {
        this.logError(`Failed to create new tab:`, err);
      }
    } else {
      // For regular clicks, navigate in the same tab
      this.logDebug(`Regular navigation to ${details.url} in same tab`);
      this.deps.navigationService.loadUrl(windowId, details.url);
    }
  }

  /**
   * Loads a URL in a background tab by acquiring a view from the tab pool
   * This ensures title/favicon events fire from the actual WebContentsView
   */
  private loadBackgroundTab(tabId: string, windowId: string, url: string): void {
    this.logDebug(`Loading background tab ${tabId} with URL: ${url}`);
    this.deps.globalTabPool.acquireView(tabId, windowId)
      .then(async (view) => {
        try {
          // Load the URL in the background tab
          await view.webContents.loadURL(url);
          this.logDebug(`Background tab ${tabId} loaded successfully`);
        } catch (loadErr) {
          this.logDebug(`Failed to load URL in background tab ${tabId}: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
        }
      })
      .catch(err => {
        this.logDebug(`Failed to acquire view for background tab ${tabId}: ${err.message}`);
      });
  }

  public navigate(windowId: string, action: 'back' | 'forward' | 'reload' | 'stop'): void {
    const activeTabId = this.deps.stateService.getState(windowId)?.activeTabId;
    if (!activeTabId) return;

    const view = this.deps.viewManager.getView(activeTabId);
    if (!view) return;

    const wc = view.webContents;
    switch (action) {
      case 'back': wc.goBack(); break;
      case 'forward': wc.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'stop': wc.stop(); break;
    }
  }

  public setBounds(windowId: string, bounds: Electron.Rectangle): void {
    this.deps.stateService.setBounds(windowId, bounds);
  }

  public executeContextMenuAction(windowId: string, action: string, data?: BrowserActionData): Promise<void> {
    return this.deps.navigationService.executeContextMenuAction(windowId, action, data);
  }

  public async destroyBrowserView(windowId: string): Promise<void> {
    try {
      const state = this.deps.stateService.getState(windowId);
      if (state) {
        // Clean up view mappings for this window
        await this.deps.viewManager.cleanupWindow(windowId);
        
        // Release all tab views from the pool
        await Promise.all(state.tabs.map(tab => this.deps.viewManager.releaseView(tab.id)));
        
        // Remove state
        this.deps.stateService.removeState(windowId);
      }
    } catch (error) {
      this.logError(`Error destroying browser view for window ${windowId}:`, error);
    }
  }

  /**
   * Prefetch favicons for multiple windows - used by NotebookCompositionService
   * Since we now load tabs immediately, this can return cached favicons from tab state
   */
  public async prefetchFaviconsForWindows(
    windows: Array<{ windowId: string; url: string }>
  ): Promise<Map<string, string | null>> {
    this.logInfo(`Prefetching favicons for ${windows.length} windows`);
    const faviconMap = new Map<string, string | null>();
    
    for (const { windowId, url } of windows) {
      // windowId here is actually a tabId in the context of NotebookCompositionService
      const tabId = windowId;
      
      // Try to get favicon from existing tab state first
      let foundFavicon = false;
      for (const [winId, state] of this.deps.stateService.states.entries()) {
        const tab = state.tabs.find(t => t.id === tabId);
        if (tab && tab.faviconUrl) {
          faviconMap.set(tabId, tab.faviconUrl);
          foundFavicon = true;
          break;
        }
      }
      
      // If no favicon in state and we have a URL, we could trigger a load
      // But since our new architecture loads tabs immediately, favicons should be available
      if (!foundFavicon) {
        this.logDebug(`No favicon found for tab ${tabId} with URL ${url}`);
        faviconMap.set(tabId, null);
      }
    }
    
    this.logInfo(`Favicon prefetch completed. Got ${Array.from(faviconMap.values()).filter(v => v !== null).length} favicons`);
    return faviconMap;
  }

  // Missing methods that IPC handlers expect
  public setBackgroundColor(windowId: string, color: string): void {
    const activeTabId = this.deps.stateService.getState(windowId)?.activeTabId;
    if (!activeTabId) return;

    const view = this.deps.viewManager.getView(activeTabId);
    if (view) {
      view.setBackgroundColor(color);
    }
  }

  public setVisibility(windowId: string, shouldBeDrawn: boolean, isFocused?: boolean): void {
    const activeTabId = this.deps.stateService.getState(windowId)?.activeTabId;
    if (!activeTabId) return;

    const view = this.deps.viewManager.getView(activeTabId);
    if (view) {
      if (shouldBeDrawn) {
        this.deps.mainWindow.contentView.addChildView(view);
      } else {
        this.deps.mainWindow.contentView.removeChildView(view);
      }
    }
  }

  public async captureSnapshot(windowId: string): Promise<string> {
    return this.deps.snapshotService.captureSnapshotString(windowId);
  }

  public async freezeWindow(windowId: string): Promise<string | null> {
    return this.deps.snapshotService.freezeWindow(windowId);
  }

  public async unfreezeWindow(windowId: string): Promise<void> {
    return this.deps.snapshotService.unfreezeWindow(windowId);
  }

  public getBrowserState(windowId: string): ClassicBrowserPayload | undefined {
    return this.deps.stateService.getState(windowId);
  }

  public updateTabBookmarkStatus(windowId: string, tabId: string, isBookmarked: boolean, jobId?: string, errorMessage?: string): void {
    const updates: Partial<TabState> = { isBookmarked };
    if (jobId !== undefined) {
      updates.processingJobId = jobId;
    }
    if (errorMessage !== undefined) {
      updates.bookmarkError = errorMessage;
    }
    this.deps.stateService.updateTab(windowId, tabId, updates);
  }

  public refreshTabState(windowId: string): void {
    // Force a state refresh (but not navigation check since state hasn't actually changed)
    const state = this.deps.stateService.getState(windowId);
    if (state) {
      this.deps.stateService.setState(windowId, state, false); // Don't force navigation check
    }
  }

  public hideContextMenuOverlay(windowId: string): void {
    this.deps.viewManager.hideContextMenuOverlay(windowId);
  }

  // LEGACY: Will be handled directly by ViewManager
  public syncViewStackingOrder(orderedWindows: Array<{ id: string; isFrozen: boolean; isMinimized: boolean }>): void {
    this.deps.viewManager.handleZOrderUpdate({ orderedWindows: orderedWindows.map(w => ({ windowId: w.id, zIndex: 0, isFocused: false, isMinimized: w.isMinimized })) });
  }

  public showAndFocusView(windowId: string): void {
    const activeTabId = this.deps.stateService.getState(windowId)?.activeTabId;
    if (!activeTabId) return;

    const view = this.deps.viewManager.getView(activeTabId);
    if (view) {
      this.deps.mainWindow.contentView.addChildView(view);
      view.webContents.focus();
    }
  }

  public async destroyAllBrowserViews(): Promise<void> {
    // Get all windows and destroy their views
    const allStates = this.deps.stateService.getAllStates();
    await Promise.all(Array.from(allStates.keys()).map(windowId => this.destroyBrowserView(windowId)));
  }


  public async transferTabToNotebook(sourceWindowId: string, tabId: string, targetNotebookId: string): Promise<void> {
    // TODO: Implement tab transfer to notebook functionality
    // This would involve:
    // 1. Getting the tab's URL and content
    // 2. Creating a new object/entry in the target notebook
    // 3. Optionally closing the tab from the browser
    throw new Error('transferTabToNotebook not yet implemented');
  }
}
