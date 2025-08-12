import { useEffect } from 'react';
import { StoreApi } from 'zustand';
import { WindowStoreState } from '@/store/windowStore';

/**
 * Hook that synchronizes window state from the renderer to the main process.
 * Replaces the old useWindowLifecycleSync hook with a unified approach.
 * 
 * @param store - The Zustand window store instance
 */
export function useWindowStateSync(store: StoreApi<WindowStoreState>) {
  useEffect(() => {
    if (!window.api?.updateWindowState) {
      console.warn('[WindowStateSync] API not available');
      return;
    }

    // Send initial state on mount
    const initialState = store.getState();
    console.log('[WindowStateSync] Sending initial state:', initialState.windows.length, 'windows');
    window.api.updateWindowState(initialState.windows);

    // Subscribe to window state changes
    const unsubscribe = store.subscribe(
      (state) => state.windows,
      (windows) => {
        console.log('[WindowStateSync] Window state changed, sending update:', windows.length, 'windows');
        window.api.updateWindowState(windows);
      }
    );

    return unsubscribe;
  }, [store]);
}