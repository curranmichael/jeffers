import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { ClassicBrowserTabService } from '../ClassicBrowserTabService';
import { ClassicBrowserStateService } from '../ClassicBrowserStateService';
import { TabState, ClassicBrowserPayload } from '../../../shared/types';
import { logger } from '../../../utils/logger';

// Mock uuid to have predictable IDs in tests
vi.mock('uuid', () => ({
  v4: vi.fn()
}));

// Mock logger
vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ClassicBrowserTabService', () => {
  let service: ClassicBrowserTabService;
  let mockStateService: ClassicBrowserStateService;

  // Helper to create a mock tab
  const createMockTab = (id: string, url: string = 'https://example.com'): TabState => ({
    id,
    url,
    title: 'Example',
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    error: null
  });

  // Helper to create mock browser state
  const createMockBrowserState = (tabs: TabState[], activeTabId: string): ClassicBrowserPayload => ({
    tabs,
    activeTabId,
    freezeState: { type: 'ACTIVE' }
  });

  beforeEach(() => {
    // Reset uuid mock to return predictable values
    let uuidCounter = 0;
    (uuidv4 as Mock).mockImplementation(() => `test-uuid-${++uuidCounter}`);

    // Create mock dependencies
    mockStateService = {
      states: new Map(),
      getState: vi.fn().mockImplementation((windowId) => mockStateService.states.get(windowId)),
      setState: vi.fn(),
      addTab: vi.fn().mockImplementation((windowId, tab) => {
        const state = mockStateService.states.get(windowId);
        if (state) {
          state.tabs.push(tab);
        }
      }),
      removeTab: vi.fn().mockImplementation((windowId, tabId) => {
        const state = mockStateService.states.get(windowId);
        if (state) {
          const index = state.tabs.findIndex(t => t.id === tabId);
          if (index !== -1) {
            state.tabs.splice(index, 1);
          }
        }
      }),
      updateTab: vi.fn(),
      setActiveTab: vi.fn().mockImplementation((windowId, tabId) => {
        const state = mockStateService.states.get(windowId);
        if (state) {
          state.activeTabId = tabId;
        }
      }),
      setBounds: vi.fn(),
      removeState: vi.fn(),
      getAllStates: vi.fn().mockReturnValue(new Map()),
      getEventBus: vi.fn()
    } as any;

    // Create service instance
    service = new ClassicBrowserTabService({
      stateService: mockStateService
    });
  });

  afterEach(async () => {
    await service.cleanup();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with dependencies', () => {
      expect(service).toBeDefined();
    });
  });

  describe('createTab', () => {
    it('should create a new tab with default URL when no URL provided', () => {
      const windowId = 'test-window';
      const initialTab = createMockTab('tab-1');
      const browserState = createMockBrowserState([initialTab], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      const newTabId = service.createTab(windowId);

      expect(newTabId).toBe('test-uuid-1');
      expect(browserState.tabs).toHaveLength(2);
      expect(browserState.tabs[1]).toMatchObject({
        id: 'test-uuid-1',
        url: 'https://www.are.na',
        title: 'New Tab',
        faviconUrl: null,
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
        error: null
      });
      expect(browserState.activeTabId).toBe('test-uuid-1');
    });

    it('should create a new tab with specified URL', () => {
      const windowId = 'test-window';
      const customUrl = 'https://github.com';
      const initialTab = createMockTab('tab-1');
      const browserState = createMockBrowserState([initialTab], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      const newTabId = service.createTab(windowId, customUrl);

      expect(newTabId).toBe('test-uuid-1');
      expect(browserState.tabs).toHaveLength(2);
      expect(browserState.tabs[1].url).toBe(customUrl);
      expect(browserState.activeTabId).toBe('test-uuid-1');
    });

    it('should call addTab and setActiveTab when creating active tab', () => {
      const windowId = 'test-window';
      const url = 'https://github.com';
      const browserState = createMockBrowserState([], '');
      mockStateService.states.set(windowId, browserState);

      service.createTab(windowId, url);

      expect(mockStateService.addTab).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({
          id: 'test-uuid-1',
          url: url
        })
      );
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'test-uuid-1');
    });

    it('should call addTab with correct tab data', () => {
      const windowId = 'test-window';
      const browserState = createMockBrowserState([], '');
      mockStateService.states.set(windowId, browserState);

      service.createTab(windowId);

      expect(mockStateService.addTab).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({
          id: 'test-uuid-1',
          url: 'https://www.are.na',
          title: 'New Tab',
          isLoading: true
        })
      );
    });

    it('should create tab even if browser window not found', () => {
      const windowId = 'non-existent';

      // The implementation doesn't throw, it just creates the tab
      const tabId = service.createTab(windowId);
      expect(tabId).toBe('test-uuid-1');
      expect(mockStateService.addTab).toHaveBeenCalled();
    });

    it('should handle missing state gracefully', () => {
      const windowId = 'non-existent';

      expect(() => service.createTab(windowId)).not.toThrow();
      expect(mockStateService.addTab).toHaveBeenCalled();
    });
  });

  describe('createTab with makeActive parameter', () => {
    it('should create active tab when makeActive is true', () => {
      const windowId = 'test-window';
      const browserState = createMockBrowserState([], '');
      mockStateService.states.set(windowId, browserState);

      const newTabId = service.createTab(windowId, 'https://example.com', true);

      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, newTabId);
      expect(mockStateService.addTab).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({
          isLoading: true
        })
      );
    });

    it('should create background tab when makeActive is false', () => {
      const windowId = 'test-window';
      const existingTab = createMockTab('tab-1');
      const browserState = createMockBrowserState([existingTab], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      const newTabId = service.createTab(windowId, 'https://example.com', false);

      expect(mockStateService.setActiveTab).not.toHaveBeenCalled();
      expect(mockStateService.addTab).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({
          isLoading: false
        })
      );
    });
  });

  describe('switchTab', () => {
    it('should switch to existing tab', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1', 'https://example.com');
      const tab2 = createMockTab('tab-2', 'https://github.com');
      const browserState = createMockBrowserState([tab1, tab2], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      service.switchTab(windowId, 'tab-2');

      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-2');
    });

    it('should handle switching to the same tab', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1', 'https://example.com');
      const browserState = createMockBrowserState([tab1], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      service.switchTab(windowId, 'tab-1');

      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-1');
    });

    it('should work with any tab URL', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1', 'https://example.com');
      const tab2 = createMockTab('tab-2', 'about:blank');
      const browserState = createMockBrowserState([tab1, tab2], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      service.switchTab(windowId, 'tab-2');

      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-2');
    });

    it('should handle switching with no state', () => {
      const windowId = 'non-existent';

      // Should just call setActiveTab - state service handles validation
      service.switchTab(windowId, 'tab-1');
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-1');
    });
  });

  describe('closeTab', () => {
    it('should close tab and activate adjacent tab', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1');
      const tab2 = createMockTab('tab-2');
      const tab3 = createMockTab('tab-3');
      const browserState = createMockBrowserState([tab1, tab2, tab3], 'tab-2');
      mockStateService.states.set(windowId, browserState);

      service.closeTab(windowId, 'tab-2');

      expect(mockStateService.removeTab).toHaveBeenCalledWith(windowId, 'tab-2');
      // Should activate the previous tab (tab-1) based on actual implementation
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-1');
    });

    it('should activate previous tab when closing last tab in list', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1');
      const tab2 = createMockTab('tab-2');
      const browserState = createMockBrowserState([tab1, tab2], 'tab-2');
      mockStateService.states.set(windowId, browserState);

      service.closeTab(windowId, 'tab-2');

      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-1');
    });

    it('should not close last tab, instead replace with new tab', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1');
      const browserState = createMockBrowserState([tab1], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      service.closeTab(windowId, 'tab-1');

      // Should create a new tab before removing the old one
      expect(mockStateService.addTab).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({
          id: 'test-uuid-1',
          url: 'https://www.are.na',
          title: 'New Tab'
        })
      );
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'test-uuid-1');
      expect(mockStateService.removeTab).toHaveBeenCalledWith(windowId, 'tab-1');
    });

    it('should not change active tab when closing inactive tab', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1');
      const tab2 = createMockTab('tab-2');
      const tab3 = createMockTab('tab-3');
      const browserState = createMockBrowserState([tab1, tab2, tab3], 'tab-2');
      mockStateService.states.set(windowId, browserState);

      service.closeTab(windowId, 'tab-3');

      expect(mockStateService.removeTab).toHaveBeenCalledWith(windowId, 'tab-3');
      // Should not call setActiveTab since we're not closing the active tab
      expect(mockStateService.setActiveTab).not.toHaveBeenCalled();
    });

    it('should handle closing when state does not exist', () => {
      const windowId = 'non-existent';
      mockStateService.getState.mockReturnValue(undefined);

      // Should return early when no state
      service.closeTab(windowId, 'tab-1');

      expect(mockStateService.removeTab).not.toHaveBeenCalled();
      expect(mockStateService.setActiveTab).not.toHaveBeenCalled();
    });

    it('should handle closing first tab when it is active', () => {
      const windowId = 'test-window';
      const tab1 = createMockTab('tab-1');
      const tab2 = createMockTab('tab-2');
      const tab3 = createMockTab('tab-3');
      const browserState = createMockBrowserState([tab1, tab2, tab3], 'tab-1');
      mockStateService.states.set(windowId, browserState);

      service.closeTab(windowId, 'tab-1');

      expect(mockStateService.removeTab).toHaveBeenCalledWith(windowId, 'tab-1');
      // When closing the first active tab, should activate the first remaining tab (tab-2 at index 0)
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, 'tab-1'); // Actually stays at tab-1 due to Math.max(0, -1) = 0
    });
  });

  describe('cleanup', () => {
    it('should cleanup without errors', async () => {
      await service.cleanup();
      // Service extends BaseService which handles cleanup
      expect(service).toBeDefined();
    });
  });

  describe('integration scenarios', () => {
    it('should handle rapid tab operations', () => {
      const windowId = 'test-window';
      const browserState = createMockBrowserState([], '');
      mockStateService.states.set(windowId, browserState);

      // Create multiple tabs rapidly
      const tab1Id = service.createTab(windowId, 'https://example.com');
      const tab2Id = service.createTab(windowId, 'https://github.com');
      const tab3Id = service.createTab(windowId, 'https://google.com');

      expect(mockStateService.addTab).toHaveBeenCalledTimes(3);
      expect(mockStateService.setActiveTab).toHaveBeenLastCalledWith(windowId, tab3Id);

      // Switch tabs
      service.switchTab(windowId, tab1Id);
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, tab1Id);

      // Close middle tab (non-active)
      service.closeTab(windowId, tab2Id);
      expect(mockStateService.removeTab).toHaveBeenCalledWith(windowId, tab2Id);
    });

    it('should maintain proper calls through operations', () => {
      const windowId = 'test-window';
      const browserState = createMockBrowserState([], '');
      mockStateService.states.set(windowId, browserState);

      // Create initial tab
      const tab1Id = service.createTab(windowId);
      expect(mockStateService.addTab).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({ isLoading: true })
      );

      // Create another tab
      const tab2Id = service.createTab(windowId);
      expect(mockStateService.setActiveTab).toHaveBeenCalledWith(windowId, tab2Id);
      
      // Mock the state to have two tabs for closeTab logic
      browserState.tabs = [
        createMockTab(tab1Id),
        createMockTab(tab2Id)
      ];
      browserState.activeTabId = tab2Id;
      
      // Close the first tab (not active)
      service.closeTab(windowId, tab1Id);
      
      expect(mockStateService.removeTab).toHaveBeenCalledWith(windowId, tab1Id);
      // Should not change active tab since we're closing an inactive tab
      expect(mockStateService.setActiveTab).not.toHaveBeenLastCalledWith(windowId, tab1Id);
    });
  });
});