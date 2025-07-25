import { BaseService } from '../base/BaseService';
import { ObjectModelCore } from '../../models/ObjectModelCore';
import { CompositeObjectEnrichmentService } from '../CompositeObjectEnrichmentService';
import { ClassicBrowserStateService } from './ClassicBrowserStateService';
import { MediaType } from '../../shared/types/vector.types';
import { WOMIngestionService } from '../WOMIngestionService';
import { BrowserEventBus } from './BrowserEventBus';

export interface ClassicBrowserWOMServiceDeps {
  objectModelCore: ObjectModelCore;
  compositeEnrichmentService: CompositeObjectEnrichmentService;
  eventBus: BrowserEventBus;
  stateService: ClassicBrowserStateService;
  womIngestionService?: WOMIngestionService;
}

export class ClassicBrowserWOMService extends BaseService<ClassicBrowserWOMServiceDeps> {
  private tabToObjectMap: Map<string, string> = new Map();
  private tabGroupUpdateQueue: Map<string, NodeJS.Timeout> = new Map();

  constructor(deps: ClassicBrowserWOMServiceDeps) {
    super('ClassicBrowserWOMService', deps);
    this.setupEventListeners();
  }

  setLateDependencies(deps: {
    womIngestionService: WOMIngestionService,
    compositeEnrichmentService: CompositeObjectEnrichmentService
  }): void {
    this.deps.womIngestionService = deps.womIngestionService;
    this.deps.compositeEnrichmentService = deps.compositeEnrichmentService;
  }

  private setupEventListeners(): void {
    // Listen for navigation events to handle WOM integration
    this.deps.eventBus.on('view:did-navigate', async ({ windowId, url, title }) => {
      // Get tabId from state
      const browserState = this.deps.stateService.states.get(windowId);
      const activeTab = browserState?.tabs?.find(t => t.id === browserState.activeTabId);
      const tabId = activeTab?.id;
      
      await this.handleNavigation(windowId, url, title, tabId);
    });

    // Listen for async ingestion completion
    this.deps.eventBus.on('webpage:ingestion-complete', async ({ tabId, objectId }) => {
      this.tabToObjectMap.set(tabId, objectId);
      this.logDebug(`Linked tab ${tabId} to object ${objectId}`);
    });

    this.deps.eventBus.on('webpage:needs-refresh', async ({ objectId, url }) => {
      // Forward to WOM ingestion service when it's available
      this.deps.eventBus.emit('wom:refresh-needed', { objectId, url });
    });
  }

  private async handleNavigation(windowId: string, url: string, title: string, tabId?: string): Promise<void> {
    if (!tabId) return;

    // Check if webpage object exists
    const webpage = await this.deps.objectModelCore.findBySourceUri(url);
    
    if (webpage) {
      // Sync update for immediate feedback
      this.deps.objectModelCore.updateLastAccessed(webpage.id);
      this.tabToObjectMap.set(tabId, webpage.id);
      
      // Schedule potential refresh
      this.deps.eventBus.emit('webpage:needs-refresh', { objectId: webpage.id, url, windowId, tabId });
    } else {
      // Emit event for async ingestion
      this.deps.eventBus.emit('webpage:needs-ingestion', { url, title, windowId, tabId });
    }
    
    // Schedule debounced tab group update
    this.scheduleTabGroupUpdate(windowId);
  }

  async checkAndCreateTabGroup(windowId: string): Promise<void> {
    const browserState = this.deps.stateService.states.get(windowId);
    if (!browserState || browserState.tabs.length < 2) return;
    
    // Check if we already have a tab group
    if (browserState.tabGroupId) return;
    
    try {
      // Create the tab group object
      const tabGroup = await this.deps.objectModelCore.createOrUpdate({
        objectType: 'tab_group' as MediaType,
        sourceUri: `tab-group://window-${windowId}`,
        title: `Browser Window`,
        status: 'new',
        rawContentRef: null
      });
      
      browserState.tabGroupId = tabGroup.id;
      this.logInfo(`Created tab group ${tabGroup.id} for window ${windowId} with ${browserState.tabs.length} tabs`);
      
      // Schedule initial update to set child objects
      this.scheduleTabGroupUpdate(windowId);
    } catch (error) {
      this.logError(`Failed to create tab group for window ${windowId}:`, error);
    }
  }

  private scheduleTabGroupUpdate(windowId: string): void {
    // Clear existing timer if any
    const existingTimer = this.tabGroupUpdateQueue.get(windowId);
    if (existingTimer) clearTimeout(existingTimer);
    
    // Set a new timer to perform the update after a short delay
    const timeout = setTimeout(async () => {
      await this.updateTabGroupChildren(windowId);
      this.tabGroupUpdateQueue.delete(windowId);
    }, 500);
    
    this.tabGroupUpdateQueue.set(windowId, timeout);
  }

  private async updateTabGroupChildren(windowId: string): Promise<void> {
    const browserState = this.deps.stateService.states.get(windowId);
    if (!browserState?.tabGroupId) return;
    
    // Collect child object IDs from all tabs
    const childObjectIds: string[] = [];
    for (const tab of browserState.tabs) {
      const objectId = this.tabToObjectMap.get(tab.id);
      if (objectId) childObjectIds.push(objectId);
    }
    
    if (childObjectIds.length > 0) {
      // Update the tab group object with current children
      this.deps.objectModelCore.updateChildIds(browserState.tabGroupId, childObjectIds);
      
      // Schedule enrichment if we have enough children and service is available
      if (this.deps.compositeEnrichmentService) {
        await this.deps.compositeEnrichmentService.scheduleEnrichment(browserState.tabGroupId, windowId);
      }
    }
  }

  // Public methods for cleanup and tab management
  removeTabMapping(tabId: string): void {
    this.tabToObjectMap.delete(tabId);
  }

  clearWindowTabMappings(windowId: string): void {
    const browserState = this.deps.stateService.states.get(windowId);
    if (browserState) {
      browserState.tabs.forEach(tab => {
        this.tabToObjectMap.delete(tab.id);
      });
    }
  }

  async cleanup(): Promise<void> {
    // Clear all pending tab group updates
    this.tabGroupUpdateQueue.forEach(timeout => clearTimeout(timeout));
    this.tabGroupUpdateQueue.clear();
    
    // Clear tab mappings
    this.tabToObjectMap.clear();
    
    // Remove event listeners
    this.deps.eventBus.removeAllListeners('view:did-navigate');
    this.deps.eventBus.removeAllListeners('webpage:ingestion-complete');
    this.deps.eventBus.removeAllListeners('webpage:needs-refresh');
  }
}
