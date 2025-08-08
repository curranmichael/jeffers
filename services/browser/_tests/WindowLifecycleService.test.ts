import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WindowLifecycleService } from '../WindowLifecycleService';
import { BrowserEventBus } from '../BrowserEventBus';
import type { WindowMeta } from '../../../shared/types/window.types';

describe('WindowLifecycleService', () => {
  let service: WindowLifecycleService;
  let eventBus: BrowserEventBus;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    eventBus = new BrowserEventBus();
    emitSpy = vi.spyOn(eventBus, 'emit');
    service = new WindowLifecycleService({ eventBus });
  });

  describe('processWindowStateChanges', () => {
    it('should emit focus-changed event when browser window focus changes', async () => {
      // Arrange
      const initialWindows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: false,
          isMinimized: false
        }
      ];
      
      const updatedWindows: WindowMeta[] = [
        {
          ...initialWindows[0],
          isFocused: true
        }
      ];

      // Act
      await service.processWindowStateChanges(initialWindows);
      await service.processWindowStateChanges(updatedWindows);

      // Assert
      expect(emitSpy).toHaveBeenCalledWith('window:focus-changed', {
        windowId: 'browser-1',
        isFocused: true,
        zIndex: 1
      });
    });

    it('should emit minimized event when browser window is minimized', async () => {
      // Arrange
      const initialWindows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true,
          isMinimized: false
        }
      ];
      
      const minimizedWindows: WindowMeta[] = [
        {
          ...initialWindows[0],
          isMinimized: true
        }
      ];

      // Act
      await service.processWindowStateChanges(initialWindows);
      await service.processWindowStateChanges(minimizedWindows);

      // Assert
      expect(emitSpy).toHaveBeenCalledWith('window:minimized', {
        windowId: 'browser-1'
      });
    });

    it('should emit restored event when browser window is restored from minimized', async () => {
      // Arrange
      const minimizedWindows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 2,
          isFocused: false,
          isMinimized: true
        }
      ];
      
      const restoredWindows: WindowMeta[] = [
        {
          ...minimizedWindows[0],
          isMinimized: false
        }
      ];

      // Act
      await service.processWindowStateChanges(minimizedWindows);
      await service.processWindowStateChanges(restoredWindows);

      // Assert
      expect(emitSpy).toHaveBeenCalledWith('window:restored', {
        windowId: 'browser-1',
        zIndex: 2
      });
    });

    it('should emit z-order-update when browser window z-index changes', async () => {
      // Arrange
      const initialWindows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser 1',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true,
          isMinimized: false
        },
        {
          id: 'browser-2',
          type: 'classic-browser',
          title: 'Browser 2',
          x: 100,
          y: 100,
          width: 800,
          height: 600,
          zIndex: 2,
          isFocused: false,
          isMinimized: false
        }
      ];
      
      const reorderedWindows: WindowMeta[] = [
        { ...initialWindows[0], zIndex: 2 },
        { ...initialWindows[1], zIndex: 1 }
      ];

      // Act
      await service.processWindowStateChanges(initialWindows);
      emitSpy.mockClear();
      await service.processWindowStateChanges(reorderedWindows);

      // Assert
      expect(emitSpy).toHaveBeenCalledWith('window:z-order-update', {
        orderedWindows: [
          { windowId: 'browser-2', zIndex: 1, isFocused: false, isMinimized: false },
          { windowId: 'browser-1', zIndex: 2, isFocused: true, isMinimized: false }
        ]
      });
    });

    it('should emit z-order-update when browser window count changes', async () => {
      // Arrange
      const singleWindow: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true,
          isMinimized: false
        }
      ];
      
      const twoWindows: WindowMeta[] = [
        ...singleWindow,
        {
          id: 'browser-2',
          type: 'classic-browser',
          title: 'Browser 2',
          x: 100,
          y: 100,
          width: 800,
          height: 600,
          zIndex: 2,
          isFocused: false,
          isMinimized: false
        }
      ];

      // Act
      await service.processWindowStateChanges(singleWindow);
      emitSpy.mockClear();
      await service.processWindowStateChanges(twoWindows);

      // Assert
      expect(emitSpy).toHaveBeenCalledWith('window:z-order-update', {
        orderedWindows: [
          { windowId: 'browser-1', zIndex: 1, isFocused: true, isMinimized: false },
          { windowId: 'browser-2', zIndex: 2, isFocused: false, isMinimized: false }
        ]
      });
    });

    it('should ignore non-browser windows', async () => {
      // Arrange
      const mixedWindows: WindowMeta[] = [
        {
          id: 'notebook-1',
          type: 'notebook',
          title: 'Notebook',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: false
        },
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 100,
          y: 100,
          width: 800,
          height: 600,
          zIndex: 2,
          isFocused: true,
          isMinimized: false
        }
      ];
      
      const updatedWindows: WindowMeta[] = [
        { ...mixedWindows[0], isFocused: true },
        { ...mixedWindows[1], isFocused: false }
      ];

      // Act
      await service.processWindowStateChanges(mixedWindows);
      emitSpy.mockClear();
      await service.processWindowStateChanges(updatedWindows);

      // Assert - should only emit for browser window
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith('window:focus-changed', {
        windowId: 'browser-1',
        isFocused: false,
        zIndex: 2
      });
    });

    it('should handle windows with undefined isMinimized gracefully', async () => {
      // Arrange
      const windowsWithoutMinimized: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true
          // isMinimized is undefined
        }
      ];
      
      const windowsMinimized: WindowMeta[] = [
        {
          ...windowsWithoutMinimized[0],
          isMinimized: true
        }
      ];

      // Act
      await service.processWindowStateChanges(windowsWithoutMinimized);
      emitSpy.mockClear();
      await service.processWindowStateChanges(windowsMinimized);

      // Assert - should treat undefined as false
      expect(emitSpy).toHaveBeenCalledWith('window:minimized', {
        windowId: 'browser-1'
      });
    });

    it('should emit multiple events for simultaneous changes', async () => {
      // Arrange
      const initialWindows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: false,
          isMinimized: false
        }
      ];
      
      const changedWindows: WindowMeta[] = [
        {
          ...initialWindows[0],
          isFocused: true,
          zIndex: 2
        }
      ];

      // Act
      await service.processWindowStateChanges(initialWindows);
      emitSpy.mockClear();
      await service.processWindowStateChanges(changedWindows);

      // Assert - should emit both focus and z-order events
      expect(emitSpy).toHaveBeenCalledWith('window:focus-changed', {
        windowId: 'browser-1',
        isFocused: true,
        zIndex: 2
      });
      expect(emitSpy).toHaveBeenCalledWith('window:z-order-update', {
        orderedWindows: [
          { windowId: 'browser-1', zIndex: 2, isFocused: true, isMinimized: false }
        ]
      });
    });

    it('should not emit events when no changes occur', async () => {
      // Arrange
      const windows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true,
          isMinimized: false
        }
      ];

      // Act
      await service.processWindowStateChanges(windows);
      emitSpy.mockClear();
      await service.processWindowStateChanges(windows);

      // Assert
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should handle empty window arrays', async () => {
      // Act
      await service.processWindowStateChanges([]);
      
      // Assert - should not throw
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should sort windows by z-index in z-order-update event', async () => {
      // Arrange
      const windows: WindowMeta[] = [
        {
          id: 'browser-3',
          type: 'classic-browser',
          title: 'Browser 3',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 3,
          isFocused: false,
          isMinimized: false
        },
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser 1',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true,
          isMinimized: false
        },
        {
          id: 'browser-2',
          type: 'classic-browser',
          title: 'Browser 2',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 2,
          isFocused: false,
          isMinimized: true
        }
      ];

      // Act
      await service.processWindowStateChanges(windows);

      // Assert - should be sorted by z-index
      expect(emitSpy).toHaveBeenCalledWith('window:z-order-update', {
        orderedWindows: [
          { windowId: 'browser-1', zIndex: 1, isFocused: true, isMinimized: false },
          { windowId: 'browser-2', zIndex: 2, isFocused: false, isMinimized: true },
          { windowId: 'browser-3', zIndex: 3, isFocused: false, isMinimized: false }
        ]
      });
    });
  });

  describe('cleanup', () => {
    it('should clear previous windows cache on cleanup', async () => {
      // Arrange
      const windows: WindowMeta[] = [
        {
          id: 'browser-1',
          type: 'classic-browser',
          title: 'Browser',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1,
          isFocused: true,
          isMinimized: false
        }
      ];

      // Act
      await service.processWindowStateChanges(windows);
      await service.cleanup();
      emitSpy.mockClear();
      
      // Process same windows again - should emit z-order since cache was cleared
      await service.processWindowStateChanges(windows);

      // Assert
      expect(emitSpy).toHaveBeenCalledWith('window:z-order-update', expect.any(Object));
    });
  });
});