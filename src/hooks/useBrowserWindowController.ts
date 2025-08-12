import { useEffect, useCallback } from 'react';
import type { StoreApi } from 'zustand';
import { logger } from '../../utils/logger';
import type { WindowStoreState } from '../store/windowStoreFactory';
import type { WindowMeta, ClassicBrowserPayload, BrowserFreezeState } from '../../shared/types/window.types';

// Freeze state constants
const VALID_FREEZE_STATES = ['ACTIVE', 'CAPTURING', 'AWAITING_RENDER', 'FROZEN'] as const;
const CAPTURE_TIMEOUT_MS = 5000; // 5 seconds max for capture operation

// Validation helper
const isValidFreezeState = (state: string): state is BrowserFreezeState['type'] => {
  return VALID_FREEZE_STATES.includes(state as BrowserFreezeState['type']);
};

/**
 * Controller hook that manages the browser window freeze/unfreeze state machine.
 * This is the single owner of all freeze/unfreeze logic, eliminating race conditions.
 */
export function useBrowserWindowController(
  windowId: string,
  activeStore: StoreApi<WindowStoreState>
) {
  // Helper to get current window metadata
  const getWindowMeta = useCallback((): WindowMeta | undefined => {
    return activeStore.getState().windows.find(w => w.id === windowId);
  }, [windowId, activeStore]);

  // Helper to update the browser freeze state
  const setBrowserFreezeState = useCallback((newState: BrowserFreezeState) => {
    const currentMeta = getWindowMeta();
    if (!currentMeta || currentMeta.type !== 'classic-browser') {
      logger.warn(`[useBrowserWindowController] Cannot update freeze state for non-browser window ${windowId}`);
      return;
    }

    const currentPayload = currentMeta.payload as ClassicBrowserPayload;
    
    activeStore.getState().updateWindowProps(windowId, {
      payload: {
        ...currentPayload,
        freezeState: newState
      }
    });
    
    logger.debug(`[useBrowserWindowController] Updated freeze state for ${windowId} to ${newState.type}`);
  }, [windowId, activeStore, getWindowMeta]);

  // Watch for focus changes and trigger state transitions
  useEffect(() => {
    let previousFocused: boolean | undefined;
    
    const unsubscribe = activeStore.subscribe((state) => {
      const window = state.windows.find(w => w.id === windowId);
      const isFocused = window?.isFocused;
      
      // Check if focus changed
      if (isFocused !== previousFocused && previousFocused !== undefined) {
        const windowMeta = getWindowMeta();
        if (!windowMeta || windowMeta.type !== 'classic-browser') return;
        
        const payload = windowMeta.payload as ClassicBrowserPayload;
        
        // Check if freezeState exists (might not be initialized yet)
        if (!payload.freezeState) {
          logger.debug(`[useBrowserWindowController] No freezeState yet for window ${windowId}`);
          return;
        }
        
        if (!isFocused && !window?.isMinimized && payload.freezeState.type === 'ACTIVE') {
          // Window lost focus and is not minimized - start capture process
          logger.info(`[useBrowserWindowController] Window ${windowId} lost focus, starting capture`);
          setBrowserFreezeState({ type: 'CAPTURING' });
        } else if (isFocused && payload.freezeState.type !== 'ACTIVE') {
          // Window gained focus - activate it
          logger.info(`[useBrowserWindowController] Window ${windowId} gained focus, activating`);
          setBrowserFreezeState({ type: 'ACTIVE' });
        }
      }
      
      previousFocused = isFocused;
    });

    return unsubscribe;
  }, [windowId, activeStore, getWindowMeta, setBrowserFreezeState]);

  // State machine logic removed - main process now handles freeze/unfreeze via windowStateHandler
  // The renderer only updates state, and the main process reacts to those state changes

  // Callback for when the snapshot has been rendered
  const handleSnapshotLoaded = useCallback(() => {
    const windowMeta = getWindowMeta();
    if (!windowMeta || windowMeta.type !== 'classic-browser') return;
    
    const payload = windowMeta.payload as ClassicBrowserPayload;
    
    if (payload.freezeState.type === 'AWAITING_RENDER') {
      logger.info(`[useBrowserWindowController] Snapshot rendered for ${windowId}, marking as frozen`);
      setBrowserFreezeState({ 
        type: 'FROZEN', 
        snapshotUrl: payload.freezeState.snapshotUrl 
      });
    }
  }, [windowId, getWindowMeta, setBrowserFreezeState]);

  return {
    handleSnapshotLoaded
  };
}

// Export for use in ClassicBrowser correction logic
export { isValidFreezeState, CAPTURE_TIMEOUT_MS };