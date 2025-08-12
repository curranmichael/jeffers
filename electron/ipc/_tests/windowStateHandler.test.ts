import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IpcMain } from 'electron';
import { registerWindowStateHandler } from '../windowStateHandler';
import { BrowserEventBus } from '../../../services/browser/BrowserEventBus';
import { ClassicBrowserSnapshotService } from '../../../services/browser/ClassicBrowserSnapshotService';
import { ClassicBrowserStateService } from '../../../services/browser/ClassicBrowserStateService';
import { WINDOW_STATE_UPDATE } from '../../../shared/ipcChannels';
import { WindowMeta } from '../../../shared/types';

describe('WindowStateHandler', () => {
  let ipcMain: { on: vi.Mock };
  let eventBus: { emit: vi.Mock };
  let snapshotService: { captureSnapshot: vi.Mock; clearSnapshot: vi.Mock };
  let stateService: { getState: vi.Mock; setState: vi.Mock };
  let handler: (event: any, windows: WindowMeta[]) => void;

  beforeEach(() => {
    ipcMain = { on: vi.fn() };
    eventBus = { emit: vi.fn() };
    snapshotService = { 
      captureSnapshot: vi.fn(),
      clearSnapshot: vi.fn()
    };
    stateService = { 
      getState: vi.fn(),
      setState: vi.fn()
    };

    registerWindowStateHandler(
      ipcMain as unknown as IpcMain,
      eventBus as unknown as BrowserEventBus,
      snapshotService as unknown as ClassicBrowserSnapshotService,
      stateService as unknown as ClassicBrowserStateService
    );

    expect(ipcMain.on).toHaveBeenCalledWith(WINDOW_STATE_UPDATE, expect.any(Function));
    handler = ipcMain.on.mock.calls[0][1];
  });

  describe('focus changes', () => {
    it('should emit focus-changed event when window focus changes', () => {
      const window1: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: false,
        zIndex: 1,
        payload: {}
      };

      handler({}, [window1]);
      eventBus.emit.mockClear();

      const focusedWindow = { ...window1, isFocused: true };
      handler({}, [focusedWindow]);

      expect(eventBus.emit).toHaveBeenCalledWith('window:focus-changed', {
        windowId: 'window-1',
        isFocused: true,
        zIndex: 1
      });
    });

    it('should not emit when focus state unchanged', () => {
      const window1: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: true,
        zIndex: 1,
        payload: {}
      };

      handler({}, [window1]);
      eventBus.emit.mockClear();
      handler({}, [window1]);

      expect(eventBus.emit).not.toHaveBeenCalledWith(
        'window:focus-changed',
        expect.any(Object)
      );
    });
  });

  describe('minimize/restore', () => {
    it('should emit minimized event when window minimized', () => {
      const window1: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: false,
        zIndex: 1,
        isMinimized: false,
        payload: {}
      };

      handler({}, [window1]);
      eventBus.emit.mockClear();

      const minimizedWindow = { ...window1, isMinimized: true };
      handler({}, [minimizedWindow]);

      expect(eventBus.emit).toHaveBeenCalledWith('window:minimized', {
        windowId: 'window-1'
      });
    });

    it('should emit restored event when window restored', () => {
      const minimized: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: false,
        zIndex: 2,
        isMinimized: true,
        payload: {}
      };

      handler({}, [minimized]);
      eventBus.emit.mockClear();

      const restored = { ...minimized, isMinimized: false };
      handler({}, [restored]);

      expect(eventBus.emit).toHaveBeenCalledWith('window:restored', {
        windowId: 'window-1',
        zIndex: 2
      });
    });
  });

  describe('freeze state transitions', () => {
    it('should capture snapshot on ACTIVE to CAPTURING transition', async () => {
      const activeWindow: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: true,
        zIndex: 1,
        payload: { freezeState: { type: 'ACTIVE' } }
      };

      handler({}, [activeWindow]);
      
      const capturingWindow = {
        ...activeWindow,
        payload: { freezeState: { type: 'CAPTURING' } }
      };

      const mockSnapshot = { snapshot: 'data:image/png;base64,test' };
      snapshotService.captureSnapshot.mockResolvedValue(mockSnapshot);
      stateService.getState.mockReturnValue({ 
        id: 'window-1',
        freezeState: { type: 'CAPTURING' }
      });

      handler({}, [capturingWindow]);

      await vi.waitFor(() => {
        expect(snapshotService.captureSnapshot).toHaveBeenCalledWith('window-1');
      });

      await vi.waitFor(() => {
        expect(stateService.setState).toHaveBeenCalledWith('window-1', {
          id: 'window-1',
          freezeState: { 
            type: 'AWAITING_RENDER',
            snapshotUrl: 'data:image/png;base64,test'
          }
        });
      });
    });

    it('should handle snapshot capture failure', async () => {
      const activeWindow: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: true,
        zIndex: 1,
        payload: { freezeState: { type: 'ACTIVE' } }
      };

      handler({}, [activeWindow]);
      
      const capturingWindow = {
        ...activeWindow,
        payload: { freezeState: { type: 'CAPTURING' } }
      };

      snapshotService.captureSnapshot.mockResolvedValue(null);
      stateService.getState.mockReturnValue({ 
        id: 'window-1',
        freezeState: { type: 'CAPTURING' }
      });

      handler({}, [capturingWindow]);

      await vi.waitFor(() => {
        expect(stateService.setState).toHaveBeenCalledWith('window-1', {
          id: 'window-1',
          freezeState: { type: 'ACTIVE' }
        });
      });
    });

    it('should transition from AWAITING_RENDER to FROZEN', () => {
      const awaitingWindow: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: false,
        zIndex: 1,
        payload: { 
          freezeState: { 
            type: 'AWAITING_RENDER',
            snapshotUrl: 'data:image/png;base64,test'
          }
        }
      };

      handler({}, [awaitingWindow]);
      
      const frozenWindow = {
        ...awaitingWindow,
        payload: { 
          freezeState: { 
            type: 'FROZEN',
            snapshotUrl: 'data:image/png;base64,test'
          }
        }
      };

      stateService.getState.mockReturnValue({ 
        id: 'window-1',
        freezeState: awaitingWindow.payload.freezeState
      });

      handler({}, [frozenWindow]);

      expect(stateService.setState).toHaveBeenCalledWith('window-1', {
        id: 'window-1',
        freezeState: frozenWindow.payload.freezeState
      });
    });

    it('should unfreeze and clear snapshot on transition to ACTIVE', () => {
      const frozenWindow: WindowMeta = {
        id: 'window-1',
        type: 'classic-browser',
        isFocused: true,
        zIndex: 1,
        payload: { 
          freezeState: { 
            type: 'FROZEN',
            snapshotUrl: 'data:image/png;base64,test'
          }
        }
      };

      handler({}, [frozenWindow]);
      
      const activeWindow = {
        ...frozenWindow,
        payload: { freezeState: { type: 'ACTIVE' } }
      };

      stateService.getState.mockReturnValue({ 
        id: 'window-1',
        freezeState: frozenWindow.payload.freezeState
      });

      handler({}, [activeWindow]);

      expect(stateService.setState).toHaveBeenCalledWith('window-1', {
        id: 'window-1',
        freezeState: { type: 'ACTIVE' }
      });
      expect(snapshotService.clearSnapshot).toHaveBeenCalledWith('window-1');
    });
  });

  describe('non-browser windows', () => {
    it('should ignore non-browser windows', () => {
      const chatWindow: WindowMeta = {
        id: 'chat-1',
        type: 'chat',
        isFocused: true,
        zIndex: 1,
        payload: {}
      };

      handler({}, [chatWindow]);

      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });
});