
import { v4 as uuidv4 } from 'uuid';
import { BaseService } from '../base/BaseService';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { TabState, TabPoolState } from '../../shared/types/window.types';

export interface ClassicBrowserTabServiceDeps {
  stateService: ClassicBrowserStateService;
}

/**
 * Handles the business logic for tab-related actions by modifying
 * the state in ClassicBrowserStateService.
 */
export class ClassicBrowserTabService extends BaseService<ClassicBrowserTabServiceDeps> {
  constructor(deps: ClassicBrowserTabServiceDeps) {
    super('ClassicBrowserTabService', deps);
  }

  public createTab(windowId: string, url?: string, makeActive: boolean = true): string {
    const tabId = uuidv4();
    
    const newTab: TabState = {
      id: tabId,
      url: url || '',  // Empty string for new tab page
      title: 'New Tab',
      faviconUrl: null,
      isLoading: false,  // New tabs don't start loading
      loadingProgress: 0,
      canGoBack: false,
      canGoForward: false,
      error: null,
      poolState: TabPoolState.INACTIVE,  // New tabs start inactive (no view)
      lastAccessed: Date.now(),
      windowId: windowId,
    };

    this.deps.stateService.addTab(windowId, newTab);
    if (makeActive) {
      this.deps.stateService.setActiveTab(windowId, tabId);
    }

    return tabId;
  }

  public switchTab(windowId: string, tabId: string): void {
    this.deps.stateService.setActiveTab(windowId, tabId);
  }

  public closeTab(windowId: string, tabIdToClose: string): void {
    const state = this.deps.stateService.getState(windowId);
    if (!state) return;

    if (state.tabs.length === 1) {
      this.createTab(windowId, '', true);  // Create a new tab with empty URL
      this.deps.stateService.removeTab(windowId, tabIdToClose);
      return;
    }

    let newActiveTabId = state.activeTabId;
    if (state.activeTabId === tabIdToClose) {
      const tabIndex = state.tabs.findIndex(t => t.id === tabIdToClose);
      // Standard browser behavior: move to the right tab unless closing the last tab
      const newActiveIndex = tabIndex === state.tabs.length - 1
        ? tabIndex - 1  // Last tab: move left
        : tabIndex + 1; // Any other tab: move right
      newActiveTabId = state.tabs[newActiveIndex].id;
    }

    // Set the new active tab before removing the old one to avoid invalid state
    if (state.activeTabId === tabIdToClose) {
      this.deps.stateService.setActiveTab(windowId, newActiveTabId);
    }
    this.deps.stateService.removeTab(windowId, tabIdToClose);
  }
}
