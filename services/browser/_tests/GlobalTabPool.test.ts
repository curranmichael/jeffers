import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GlobalTabPool } from '../GlobalTabPool';
import { BrowserEventBus } from '../BrowserEventBus';
import type { ClassicBrowserSnapshotService } from '../ClassicBrowserSnapshotService';

// Mock Electron
vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(() => ({
    webContents: {
      loadURL: vi.fn().mockResolvedValue(undefined),
      getURL: vi.fn().mockReturnValue('https://example.com'),
      isDestroyed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      setWindowOpenHandler: vi.fn(), // Add missing method
      setAudioMuted: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(), // Add missing close method
      getTitle: vi.fn().mockReturnValue('Example Title'),
      canGoBack: vi.fn().mockReturnValue(false),
      canGoForward: vi.fn().mockReturnValue(false),
    },
    setBackgroundColor: vi.fn(),
    setBorderRadius: vi.fn(), // Add the missing method
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
  })),
}));

describe('GlobalTabPool', () => {
  let pool: GlobalTabPool;
  let eventBus: BrowserEventBus;
  let snapshotService: ClassicBrowserSnapshotService;

  beforeEach(() => {
    eventBus = new BrowserEventBus();
    // Mock the snapshot service
    snapshotService = {
      captureBeforeEviction: vi.fn().mockResolvedValue(undefined)
    } as unknown as ClassicBrowserSnapshotService;
    pool = new GlobalTabPool({ eventBus, snapshotService });
  });

  describe('cleanupWindowMappings', () => {
    it('should remove all tab mappings for a window', async () => {
      // Arrange: Create tabs associated with different windows
      await pool.acquireView('tab1', 'window1');
      await pool.acquireView('tab2', 'window1');
      await pool.acquireView('tab3', 'window2');

      // Act: Clean up mappings for window1
      pool.cleanupWindowMappings('window1');

      // Assert: window1 tabs should not have mappings anymore
      // We can verify this indirectly by checking that snapshot capture won't be called for window1
      const captureBeforeEvictionSpy = vi.spyOn(snapshotService, 'captureBeforeEviction');
      
      // Force eviction by filling the pool
      for (let i = 0; i < 10; i++) {
        await pool.acquireView(`new-tab-${i}`, 'window3');
      }

      // Check that captureBeforeEviction was not called for window1 tabs
      const window1Calls = captureBeforeEvictionSpy.mock.calls.filter(
        call => call[0] === 'window1'
      );
      
      expect(window1Calls).toHaveLength(0);
    });

    it('should handle cleanup for non-existent window gracefully', () => {
      // Should not throw when cleaning up a window that was never mapped
      expect(() => pool.cleanupWindowMappings('non-existent')).not.toThrow();
    });
  });
});