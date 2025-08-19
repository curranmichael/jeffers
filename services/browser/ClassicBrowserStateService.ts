
import { BrowserWindow } from 'electron';
import { ON_CLASSIC_BROWSER_STATE } from '../../shared/ipcChannels';
import { ClassicBrowserPayload, TabState } from '../../shared/types';
import { BaseService } from '../base/BaseService';
import { BrowserEventBus } from './BrowserEventBus';

// Progress milestones for navigation events
const PROGRESS_START_LOADING = 5;
const PROGRESS_DID_NAVIGATE = 35;
const PROGRESS_DOM_READY = 60;
const PROGRESS_FRAME_FINISH = 85;
const PROGRESS_STOP_LOADING = 100;

export interface ClassicBrowserStateServiceDeps {
  mainWindow: BrowserWindow;
  eventBus: BrowserEventBus;
}

/**
 * Service responsible for managing browser window states.
 * This service is the single source of truth for all browser state.
 */
export class ClassicBrowserStateService extends BaseService<ClassicBrowserStateServiceDeps> {
  public states = new Map<string, ClassicBrowserPayload>();
  private pendingStateEmissions = new Map<string, NodeJS.Timeout>();
  private tabProgressMap = new Map<string, number>();

  constructor(deps: ClassicBrowserStateServiceDeps) {
    super('ClassicBrowserStateService', deps);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const { eventBus } = this.deps;

    // Progress tracking event listeners
    eventBus.on('view:did-start-loading', ({ tabId, windowId }) => {
      if (tabId) {
        this.setTabProgress(windowId, tabId, PROGRESS_START_LOADING);
        this.updateTab(windowId, tabId, { isLoading: true, loadingProgress: PROGRESS_START_LOADING, error: null });
      }
    });

    eventBus.on('view:did-navigate', ({ tabId, windowId }) => {
      if (tabId) {
        this.setTabProgress(windowId, tabId, PROGRESS_DID_NAVIGATE);
        this.updateTab(windowId, tabId, { loadingProgress: PROGRESS_DID_NAVIGATE });
      }
    });

    eventBus.on('view:dom-ready', ({ tabId, windowId }) => {
      if (tabId) {
        this.setTabProgress(windowId, tabId, PROGRESS_DOM_READY);
        this.updateTab(windowId, tabId, { loadingProgress: PROGRESS_DOM_READY });
      }
    });

    eventBus.on('view:did-frame-finish-load', ({ tabId, windowId, isMainFrame }) => {
      if (tabId && isMainFrame) {
        this.setTabProgress(windowId, tabId, PROGRESS_FRAME_FINISH);
        this.updateTab(windowId, tabId, { loadingProgress: PROGRESS_FRAME_FINISH });
      }
    });

    eventBus.on('view:did-stop-loading', ({ tabId, windowId }) => {
      if (tabId) {
        this.setTabProgress(windowId, tabId, PROGRESS_STOP_LOADING);
        this.updateTab(windowId, tabId, { isLoading: false, loadingProgress: PROGRESS_STOP_LOADING });
      }
    });

    eventBus.on('view:did-fail-load', ({ tabId, windowId, errorDescription }) => {
      if (tabId) {
        this.setTabProgress(windowId, tabId, PROGRESS_STOP_LOADING);
        this.updateTab(windowId, tabId, { 
          isLoading: false, 
          loadingProgress: PROGRESS_STOP_LOADING,
          error: errorDescription || 'Failed to load page'
        });
      }
    });
  }

  private setTabProgress(windowId: string, tabId: string, progress: number): void {
    const key = `${windowId}-${tabId}`;
    const currentProgress = this.tabProgressMap.get(key) || 0;
    // Only increase progress, never decrease
    if (progress > currentProgress) {
      this.tabProgressMap.set(key, progress);
    }
  }

  private getTabProgress(windowId: string, tabId: string): number {
    const key = `${windowId}-${tabId}`;
    return this.tabProgressMap.get(key) || 0;
  }

  public getState(windowId: string): ClassicBrowserPayload | undefined {
    return this.states.get(windowId);
  }

  public setState(windowId: string, state: ClassicBrowserPayload, forceNavigationCheck = false): void {
    const previousState = this.states.get(windowId);
    this.states.set(windowId, state);
    this._emitStateChange(windowId, previousState, forceNavigationCheck);
  }

  public addTab(windowId: string, tab: TabState): void {
    const state = this.getState(windowId);
    if (state) {
      const newTabs = [...state.tabs, tab];
      this.setState(windowId, { ...state, tabs: newTabs }, true); // Force navigation check for new tabs
    }
  }

  public removeTab(windowId: string, tabId: string): void {
    const state = this.getState(windowId);
    if (state) {
      const newTabs = state.tabs.filter(t => t.id !== tabId);
      this.setState(windowId, { ...state, tabs: newTabs }, true); // Force navigation check when tabs removed
    }
  }

  public updateTab(windowId: string, tabId: string, updates: Partial<TabState>): void {
    const state = this.getState(windowId);
    if (state) {
      // If loadingProgress is being updated, ensure it doesn't decrease
      if (updates.loadingProgress !== undefined) {
        const storedProgress = this.getTabProgress(windowId, tabId);
        updates.loadingProgress = Math.max(updates.loadingProgress, storedProgress);
      }
      
      // Reset progress when navigation starts fresh
      if (updates.url && state.tabs.find(t => t.id === tabId)?.url !== updates.url) {
        const key = `${windowId}-${tabId}`;
        this.tabProgressMap.set(key, 0);
        updates.loadingProgress = 0;
      }
      
      const newTabs = state.tabs.map(t => t.id === tabId ? { ...t, ...updates } : t);
      // Check if URL or loading state changed (navigation-relevant)
      const tabChanged = state.tabs.find(t => t.id === tabId);
      const hasNavigationChange = tabChanged && (
        (updates.url && updates.url !== tabChanged.url) ||
        (updates.isLoading !== undefined && updates.isLoading !== tabChanged.isLoading)
      );
      this.setState(windowId, { ...state, tabs: newTabs }, hasNavigationChange);
    }
  }

  public setActiveTab(windowId: string, tabId: string): void {
    const state = this.getState(windowId);
    if (state && state.activeTabId !== tabId) {
      this.setState(windowId, { ...state, activeTabId: tabId }, true); // Force navigation check for tab switches
    }
  }

  public setBounds(windowId: string, bounds: Electron.Rectangle): void {
    const state = this.getState(windowId);
    if (state) {
      // Bounds changes are not navigation-relevant
      this.setState(windowId, { ...state, bounds }, false);
    }
  }

  private _emitStateChange(windowId: string, previousState?: ClassicBrowserPayload, forceNavigationCheck = false): void {
    const newState = this.getState(windowId);
    if (!newState) return;

    // Clear any pending emission for this window
    const pending = this.pendingStateEmissions.get(windowId);
    if (pending) {
      clearTimeout(pending);
    }

    // Determine if this is a navigation-relevant change
    const isNavigationRelevant = forceNavigationCheck || this.isNavigationRelevantChange(previousState, newState);

    // Emit to other backend services immediately (they may need to react right away)
    this.deps.eventBus.emit('state-changed', { 
      windowId, 
      newState, 
      previousState,
      isNavigationRelevant 
    });

    // Debounce the renderer emission to prevent excessive re-renders
    // Use a slightly longer delay (50ms) to better batch rapid state changes
    const emitToRenderer = () => {
      if (this.deps.mainWindow && !this.deps.mainWindow.isDestroyed()) {
        const currentState = this.getState(windowId);
        if (currentState) {
          // Send the full state including freezeState
          this.deps.mainWindow.webContents.send(ON_CLASSIC_BROWSER_STATE, { 
            windowId, 
            update: {
              tabs: currentState.tabs,
              activeTabId: currentState.activeTabId,
              tabGroupTitle: currentState.tabGroupTitle,
              freezeState: currentState.freezeState
            }
          });
        }
      }
      this.pendingStateEmissions.delete(windowId);
    };

    const timeoutId = setTimeout(emitToRenderer, 50);
    this.pendingStateEmissions.set(windowId, timeoutId);
  }

  /**
   * Determines if a state change requires navigation handling
   */
  private isNavigationRelevantChange(previousState?: ClassicBrowserPayload, newState?: ClassicBrowserPayload): boolean {
    if (!previousState || !newState) return true; // First state is always relevant

    // Active tab changed
    if (previousState.activeTabId !== newState.activeTabId) return true;

    // Number of tabs changed
    if (previousState.tabs.length !== newState.tabs.length) return true;

    // Check if any tab's URL or loading state changed
    for (const newTab of newState.tabs) {
      const prevTab = previousState.tabs.find(t => t.id === newTab.id);
      if (!prevTab) return true; // New tab
      
      if (prevTab.url !== newTab.url || prevTab.isLoading !== newTab.isLoading) {
        return true; // URL or loading state changed
      }
    }

    // Only bounds/visual changes - not navigation relevant
    return false;
  }

  async cleanup(): Promise<void> {
    // Clear any pending emissions
    for (const timeoutId of this.pendingStateEmissions.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingStateEmissions.clear();
    
    // Clear states
    this.states.clear();
  }

  public removeState(windowId: string): void {
    this.states.delete(windowId);
  }

  public getAllStates(): Map<string, ClassicBrowserPayload> {
    return new Map(this.states);
  }

  /**
   * Get the event bus instance for other services to use
   */
  public getEventBus(): BrowserEventBus {
    return this.deps.eventBus;
  }
}
