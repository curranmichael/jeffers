import { BaseService } from '../base/BaseService';
import { ClassicBrowserViewManager } from './ClassicBrowserViewManager';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { ClassicBrowserNavigationService } from './ClassicBrowserNavigationService';
import { isAuthenticationUrl } from './url.helpers';

interface ClassicBrowserSnapshotServiceDeps {
  viewManager: ClassicBrowserViewManager;
  stateService: ClassicBrowserStateService;
  navigationService: ClassicBrowserNavigationService;
}

export class ClassicBrowserSnapshotService extends BaseService<ClassicBrowserSnapshotServiceDeps> {
  // Store snapshots by composite key: windowId:tabId
  private snapshots: Map<string, string> = new Map();
  private static readonly MAX_SNAPSHOTS = 10;

  constructor(deps: ClassicBrowserSnapshotServiceDeps) {
    super('ClassicBrowserSnapshotService', deps);
  }

  async initialize(): Promise<void> {
    // Listen for tab eviction events to capture snapshots
    const eventBus = this.deps.stateService.getEventBus();
    eventBus.on('tab:before-eviction', async ({ windowId, tabId }) => {
      this.logDebug(`Capturing snapshot for tab ${tabId} before eviction`);
      await this.captureSnapshotForEviction(windowId, tabId);
    });
  }

  async captureSnapshot(windowId: string): Promise<{ url: string; snapshot: string } | undefined> {
    // Get the active tab for this window
    const browserState = this.deps.stateService.states.get(windowId);
    if (!browserState || !browserState.activeTabId) {
      this.logWarn(`No active tab found for window ${windowId}`);
      return undefined;
    }

    const tabId = browserState.activeTabId;
    const view = this.deps.viewManager.getView(tabId);
    
    // If view is not in pool, try to get cached snapshot
    if (!view) {
      const cachedSnapshot = this.getTabSnapshot(windowId, tabId);
      if (cachedSnapshot) {
        const activeTab = browserState.tabs.find(t => t.id === tabId);
        this.logDebug(`Using cached snapshot for tab ${tabId} in window ${windowId}`);
        return { url: activeTab?.url || '', snapshot: cachedSnapshot };
      }
      this.logWarn(`No browser view found for active tab ${tabId} in window ${windowId}`);
      return undefined;
    }

    return this.execute('captureSnapshot', async () => {
      const currentUrl = view.webContents.getURL();
      if (isAuthenticationUrl(currentUrl)) {
        this.logInfo(`Skipping snapshot capture for authentication URL: ${currentUrl}`);
        return undefined;
      }

      try {
        const image = await view.webContents.capturePage();
        const snapshot = image.toDataURL();
        
        this.storeSnapshotWithLRU(windowId, tabId, snapshot);
        
        return { url: currentUrl, snapshot };
      } catch (error) {
        this.logError(`Failed to capture snapshot for window ${windowId}, tab ${tabId}:`, error);
        return undefined;
      }
    });
  }

  showAndFocusView(windowId: string): void {
    const browserState = this.deps.stateService.states.get(windowId);
    if (!browserState || !browserState.activeTabId) {
      this.logDebug(`No active tab for window ${windowId}`);
      return;
    }
    
    const snapshot = this.getTabSnapshot(windowId, browserState.activeTabId);
    
    if (snapshot) {
      this.logDebug(`Showing snapshot for window ${windowId}, tab ${browserState.activeTabId}`);
      // In a real implementation, this would emit an event or update state
      // to display the snapshot in the UI
    } else {
      this.logDebug(`No snapshot available for window ${windowId}, tab ${browserState.activeTabId}`);
    }
  }

  clearSnapshot(windowId: string): void {
    // Clear all snapshots for this window
    const keysToDelete: string[] = [];
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(`${windowId}:`)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.snapshots.delete(key));
    if (keysToDelete.length > 0) {
      this.logDebug(`Cleared ${keysToDelete.length} snapshots for window ${windowId}`);
    }
  }

  clearTabSnapshot(windowId: string, tabId: string): void {
    const key = `${windowId}:${tabId}`;
    if (this.snapshots.delete(key)) {
      this.logDebug(`Cleared snapshot for window ${windowId}, tab ${tabId}`);
    }
  }

  clearAllSnapshots(): void {
    const count = this.snapshots.size;
    this.snapshots.clear();
    this.logInfo(`Cleared all ${count} snapshots`);
  }

  private storeSnapshotWithLRU(windowId: string, tabId: string, snapshot: string): void {
    const key = `${windowId}:${tabId}`;
    
    // Remove the key if it already exists to re-add it at the end
    this.snapshots.delete(key);
    
    // If we're at max capacity, remove the oldest entry
    if (this.snapshots.size >= ClassicBrowserSnapshotService.MAX_SNAPSHOTS) {
      const oldestKey = this.snapshots.keys().next().value;
      if (oldestKey) {
        this.snapshots.delete(oldestKey);
        this.logDebug(`Removed oldest snapshot ${oldestKey} due to LRU`);
      }
    }
    
    // Add the new snapshot
    this.snapshots.set(key, snapshot);
    this.logDebug(`Stored snapshot for window ${windowId}, tab ${tabId}. Total snapshots: ${this.snapshots.size}`);
  }

  getSnapshot(windowId: string): string | undefined {
    // For backward compatibility, get snapshot for active tab
    const browserState = this.deps.stateService.states.get(windowId);
    if (!browserState || !browserState.activeTabId) {
      return undefined;
    }
    return this.getTabSnapshot(windowId, browserState.activeTabId);
  }

  getTabSnapshot(windowId: string, tabId: string): string | undefined {
    const key = `${windowId}:${tabId}`;
    return this.snapshots.get(key);
  }

  getAllSnapshots(): Map<string, string> {
    return new Map(this.snapshots);
  }

  async cleanup(): Promise<void> {
    // Remove event listeners
    const eventBus = this.deps.stateService.getEventBus();
    eventBus.removeAllListeners('tab:before-eviction');
    
    this.clearAllSnapshots();
    await super.cleanup();
  }

  // Simplified method that returns just the snapshot string for compatibility
  async captureSnapshotString(windowId: string): Promise<string> {
    const result = await this.captureSnapshot(windowId);
    return result?.snapshot || '';
  }

  // Freeze/unfreeze methods for tab-pool architecture
  async freezeWindow(windowId: string): Promise<void> {
    const result = await this.captureSnapshot(windowId);
    if (result) {
      // Update state to frozen with the snapshot
      this.deps.stateService.setState(windowId, {
        ...this.deps.stateService.getState(windowId)!,
        freezeState: { type: 'FROZEN', snapshotUrl: result.snapshot }
      });
      this.logInfo(`Froze window ${windowId} with snapshot`);
    } else {
      this.logWarn(`Failed to freeze window ${windowId} - no snapshot captured`);
    }
  }

  async unfreezeWindow(windowId: string): Promise<void> {
    const state = this.deps.stateService.getState(windowId);
    if (state) {
      this.deps.stateService.setState(windowId, {
        ...state,
        freezeState: { type: 'ACTIVE' }
      });
      this.logInfo(`Unfroze window ${windowId}`);
    }
  }

  // Method to capture snapshot before tab eviction from pool
  async captureSnapshotForEviction(windowId: string, tabId: string): Promise<void> {
    const view = this.deps.viewManager.getView(tabId);
    if (!view || view.webContents.isDestroyed()) {
      return;
    }

    try {
      const currentUrl = view.webContents.getURL();
      if (isAuthenticationUrl(currentUrl)) {
        return;
      }

      const image = await view.webContents.capturePage();
      const snapshot = image.toDataURL();
      this.storeSnapshotWithLRU(windowId, tabId, snapshot);
      this.logDebug(`Captured snapshot for tab ${tabId} before eviction`);
    } catch (error) {
      this.logError(`Failed to capture eviction snapshot for tab ${tabId}:`, error);
    }
  }
}