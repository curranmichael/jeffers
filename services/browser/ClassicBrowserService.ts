
import { BrowserWindow, HandlerDetails } from 'electron';
import { BaseService } from '../base/BaseService';
import { ClassicBrowserPayload, TabState, BrowserActionData } from '../../shared/types';
import { BrowserContextMenuData } from '../../shared/types/contextMenu.types';
import { ClassicBrowserViewManager } from './ClassicBrowserViewManager';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { ClassicBrowserNavigationService } from './ClassicBrowserNavigationService';
import { ClassicBrowserTabService } from './ClassicBrowserTabService';
import { ClassicBrowserSnapshotService } from './ClassicBrowserSnapshotService';
import { EventEmitter } from 'events';

export interface ClassicBrowserServiceDeps {
  mainWindow: BrowserWindow;
  viewManager: ClassicBrowserViewManager;
  stateService: ClassicBrowserStateService;
  navigationService: ClassicBrowserNavigationService;
  tabService: ClassicBrowserTabService;
  snapshotService: ClassicBrowserSnapshotService;
}

/**
 * The main entry point for all browser-related operations.
 * Delegates to other services to handle the actual logic.
 */
export class ClassicBrowserService extends BaseService<ClassicBrowserServiceDeps> {
  private eventEmitter = new EventEmitter();
  constructor(deps: ClassicBrowserServiceDeps) {
    super('ClassicBrowserService', deps);
  }

  async initialize(): Promise<void> {
    // Set up event listeners for tab metadata updates from WebContents
    const eventBus = this.deps.stateService.getEventBus();
    
    // Listen for title updates and update the active tab
    eventBus.on('view:page-title-updated', ({ windowId, title }) => {
      this.logDebug(`Received title update for window ${windowId}: ${title}`);
      const activeTabId = this.deps.stateService.getState(windowId)?.activeTabId;
      if (activeTabId) {
        this.deps.stateService.updateTab(windowId, activeTabId, { title });
      }
    });

    // Listen for favicon updates and update the active tab
    eventBus.on('view:page-favicon-updated', ({ windowId, faviconUrl }) => {
      this.logDebug(`Received favicon update for window ${windowId}: ${faviconUrl.length} favicons`);
      const favicon = faviconUrl.length > 0 ? faviconUrl[0] : null;
      const activeTabId = this.deps.stateService.getState(windowId)?.activeTabId;
      if (activeTabId) {
        this.deps.stateService.updateTab(windowId, activeTabId, { faviconUrl: favicon });
      }
    });

    // Listen for window open requests (CMD+click, middle-click, etc.)
    eventBus.on('view:window-open-request', ({ windowId, details }) => {
      this.handleWindowOpenRequest(windowId, details);
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
    await super.cleanup();
  }

  public createBrowserView(windowId: string, bounds: Electron.Rectangle, payload: ClassicBrowserPayload): void {
    const initialState = { 
      ...payload, 
      bounds,
      // Ensure freezeState is always set, default to ACTIVE
      freezeState: payload.freezeState || { type: 'ACTIVE' }
    };
    this.deps.stateService.setState(windowId, initialState);
    
    // Ensure there's always at least one tab when creating a browser window
    if (!initialState.tabs.length || !initialState.activeTabId) {
      this.deps.tabService.createTab(windowId, 'https://www.are.na');
    }
  }

  public createTab(windowId: string, url?: string): string {
    return this.deps.tabService.createTab(windowId, url);
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
        this.logDebug(`Created tab ${tabId} as ${makeActive ? 'active' : 'background'}`);
      } catch (err) {
        this.logError(`Failed to create new tab:`, err);
      }
    } else {
      // For regular clicks, navigate in the same tab
      this.logDebug(`Regular navigation to ${details.url} in same tab`);
      this.deps.navigationService.loadUrl(windowId, details.url);
    }
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

  // Event emitter methods for backward compatibility
  public on(event: string, listener: (...args: any[]) => void): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  public emit(event: string, ...args: any[]): boolean {
    return this.eventEmitter.emit(event, ...args);
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
      (updates as any).jobId = jobId;
    }
    if (errorMessage !== undefined) {
      (updates as any).errorMessage = errorMessage;
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

  public syncViewStackingOrder(orderedWindows: Array<{ id: string; isFrozen: boolean; isMinimized: boolean }>): void {
    this.deps.viewManager.handleZOrderUpdate({ orderedWindows: orderedWindows.map(w => ({ windowId: w.id, zIndex: 0, isFocused: false, isMinimized: w.isFrozen })) });
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

  public async prefetchFaviconsForWindows(windows: any[]): Promise<Map<string, string>> {
    // Prefetch favicons for the specified windows
    return new Map<string, string>();
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
