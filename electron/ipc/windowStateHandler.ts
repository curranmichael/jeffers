import { IpcMain } from 'electron';
import { logger } from '../../utils/logger';
import { WINDOW_STATE_UPDATE } from '../../shared/ipcChannels';
import { WindowMeta } from '../../shared/types';
import { BrowserEventBus } from '../../services/browser/BrowserEventBus';
import { ClassicBrowserSnapshotService } from '../../services/browser/ClassicBrowserSnapshotService';
import { ClassicBrowserStateService } from '../../services/browser/ClassicBrowserStateService';

/**
 * Registers the unified window state handler that replaces WindowLifecycleService
 * and syncWindowStackOrder handlers. This handler processes window state updates
 * from the renderer and emits appropriate events for the ClassicBrowserViewManager.
 */
export function registerWindowStateHandler(
  ipcMain: IpcMain,
  eventBus: BrowserEventBus,
  snapshotService: ClassicBrowserSnapshotService,
  stateService: ClassicBrowserStateService
) {
  const previousWindows = new Map<string, WindowMeta>();
  const capturesInProgress = new Set<string>();

  ipcMain.on(WINDOW_STATE_UPDATE, async (event, windows: WindowMeta[]) => {
    logger.debug('[WindowStateHandler] Received update:', windows.length, 'windows');
    
    const browserWindows = windows.filter(w => w.type === 'classic-browser');
    
    for (const window of browserWindows) {
      const prev = previousWindows.get(window.id);
      
      // Focus changes
      if (prev && prev.isFocused !== window.isFocused) {
        logger.debug('[WindowStateHandler] Focus changed for window:', window.id, 'isFocused:', window.isFocused);
        eventBus.emit('window:focus-changed', {
          windowId: window.id,
          isFocused: window.isFocused,
          zIndex: window.zIndex
        });
      }
      
      // Minimize/restore
      const wasMinimized = prev?.isMinimized ?? false;
      const isMinimized = window.isMinimized ?? false;
      if (prev && wasMinimized !== isMinimized) {
        if (isMinimized) {
          logger.debug('[WindowStateHandler] Window minimized:', window.id);
          eventBus.emit('window:minimized', { windowId: window.id });
        } else {
          logger.debug('[WindowStateHandler] Window restored:', window.id);
          eventBus.emit('window:restored', { 
            windowId: window.id, 
            zIndex: window.zIndex 
          });
        }
      }
      
      // Freeze state changes
      const currentFreezeState = window.payload?.freezeState?.type;
      const prevFreezeState = prev?.payload?.freezeState?.type;
      
      if (currentFreezeState !== prevFreezeState) {
        logger.debug('[WindowStateHandler] Freeze state changed for window:', window.id, 
          'from:', prevFreezeState, 'to:', currentFreezeState);
        
        // Handle ACTIVE → CAPTURING transition
        if (prevFreezeState === 'ACTIVE' && currentFreezeState === 'CAPTURING') {
          if (!capturesInProgress.has(window.id)) {
            capturesInProgress.add(window.id);
            
            try {
              logger.info('[WindowStateHandler] Starting snapshot capture for window:', window.id);
              const snapshot = await snapshotService.captureSnapshot(window.id);
              
              // Check if window still should be frozen (state may have changed during capture)
              const latestWindow = windows.find(w => w.id === window.id);
              if (latestWindow?.payload?.freezeState?.type !== 'ACTIVE') {
                if (snapshot) {
                  const currentState = stateService.getState(window.id);
                  if (currentState) {
                    logger.info('[WindowStateHandler] Snapshot captured, transitioning to FROZEN:', window.id);
                    await stateService.setState(window.id, {
                      ...currentState,
                      freezeState: { 
                        type: 'FROZEN', 
                        snapshotUrl: snapshot.snapshot 
                      }
                    });
                  }
                } else {
                  logger.warn('[WindowStateHandler] Snapshot capture failed for window:', window.id);
                  // Revert to ACTIVE state on failure
                  const currentState = stateService.getState(window.id);
                  if (currentState) {
                    await stateService.setState(window.id, {
                      ...currentState,
                      freezeState: { type: 'ACTIVE' }
                    });
                  }
                }
              }
            } catch (error) {
              logger.error('[WindowStateHandler] Error capturing snapshot:', error);
              // Revert to ACTIVE state on error
              const currentState = stateService.getState(window.id);
              if (currentState) {
                await stateService.setState(window.id, {
                  ...currentState,
                  freezeState: { type: 'ACTIVE' }
                });
              }
            } finally {
              capturesInProgress.delete(window.id);
            }
          }
        }
        
        // Handle FROZEN/CAPTURING → ACTIVE transition (unfreeze)
        if ((prevFreezeState === 'FROZEN' || prevFreezeState === 'CAPTURING') && 
            currentFreezeState === 'ACTIVE') {
          logger.info('[WindowStateHandler] Unfreezing window:', window.id);
          const currentState = stateService.getState(window.id);
          if (currentState) {
            await stateService.setState(window.id, {
              ...currentState,
              freezeState: { type: 'ACTIVE' }
            });
            // Clear the snapshot cache
            snapshotService.clearSnapshot(window.id);
          }
        }
      }
    }
    
    // Update previous state for all browser windows
    for (const window of browserWindows) {
      previousWindows.set(window.id, window);
    }
    
    // Clean up removed windows from previous state
    const currentWindowIds = new Set(browserWindows.map(w => w.id));
    for (const [id] of previousWindows) {
      if (!currentWindowIds.has(id)) {
        previousWindows.delete(id);
      }
    }
    
    // Check for z-order changes
    const hasBrowserWindowCountChanged = browserWindows.length !== 
      Array.from(previousWindows.values()).filter(w => w.type === 'classic-browser').length;
    
    const hasZIndexChanged = browserWindows.some(w => {
      const prev = previousWindows.get(w.id);
      return prev && prev.zIndex !== w.zIndex;
    });
    
    if (hasBrowserWindowCountChanged || hasZIndexChanged) {
      logger.debug('[WindowStateHandler] Z-order update detected');
      const orderedWindows = browserWindows
        .map(w => ({
          windowId: w.id,
          zIndex: w.zIndex,
          isFocused: w.isFocused,
          isMinimized: !!w.isMinimized
        }))
        .sort((a, b) => a.zIndex - b.zIndex);
        
      eventBus.emit('window:z-order-update', { orderedWindows });
    }
  });
  
  logger.info('[WindowStateHandler] Registered window state update handler');
}