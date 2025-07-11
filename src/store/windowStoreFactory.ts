import { create, StateCreator, StoreApi } from "zustand";
import { persist, PersistStorage, StorageValue } from "zustand/middleware";
import { useStore } from "zustand";
import { v4 as uuidv4 } from 'uuid';
import { debounce } from 'lodash-es';
import type { WindowMeta, WindowContentType, WindowPayload, ClassicBrowserPayload, TabState } from "../../shared/types/window.types"; // Adjusted path
import { logger } from "../../utils/logger";

/**
 * WindowStoreState defines the full state and actions for the windowing system.
 */
export interface WindowStoreState {
  /** Array of window metadata objects */
  windows: WindowMeta[];
  /** Adds a new window to the store */
  addWindow: (config: {
    type: WindowContentType;
    payload?: WindowPayload;
    preferredMeta?: Partial<Pick<WindowMeta, 'x' | 'y' | 'width' | 'height' | 'title'>>;
  }) => string;
  /** Removes a window from the store by its ID */
  removeWindow: (id: string) => void;
  /** Updates specified properties of a window */
  updateWindowProps: (
    id: string,
    props: Partial<Pick<WindowMeta, "x" | "y" | "width" | "height" | "title" | "payload">>
  ) => void;
  /** Sets the focus to a specified window, bringing it to the front */
  setWindowFocus: (id: string) => Promise<void>;
  /** Minimizes a window to the sidebar */
  minimizeWindow: (id: string) => void;
  /** Restores a minimized window */
  restoreWindow: (id: string) => Promise<void>;
  /** Toggles window minimized state */
  toggleMinimize: (id: string) => Promise<void>;

  // Add these for hydration tracking
  _hasHydrated: boolean;
  _setHasHydrated: (status: boolean) => void;
}

/**
 * Defines the shape of the state that is actually persisted.
 */
// _hasHydrated and _setHasHydrated should not be persisted themselves.
// PersistedWindowState will only include 'windows'.
// type PersistedWindowState = Pick<WindowStoreState, 'windows'>;
// To explicitly exclude, we define what *is* persisted.
interface PersistedWindowState {
  windows: WindowMeta[];
  // We might add other top-level persisted things here later, outside of 'windows'
}

const PERSIST_DEBOUNCE_MS = 750;
const PERSIST_MAX_WAIT_MS = 2000;
const CURRENT_PERSIST_VERSION = 4; // Increment version for freeze state machine migration

/**
 * Asynchronous storage adapter that bridges Zustand's persist() middleware
 * to our IPC-backed storage (window.api.storeGet/Set/Remove).
 */
export const notebookStateStorageAsync: PersistStorage<PersistedWindowState> = {
  getItem: async (key: string): Promise<StorageValue<PersistedWindowState> | null> => {
    try {
      if (window.api && typeof window.api.storeGet === 'function') {
        const stringValue = await window.api.storeGet(key);
        if (stringValue) {
          return JSON.parse(stringValue) as StorageValue<PersistedWindowState>;
        }
      }
      console.warn(`[Zustand Storage] window.api.storeGet not available or no value for key: ${key}`);
      return null;
    } catch (error) {
      console.error(`[Zustand Storage] Error getting item '${key}':`, error);
      return null;
    }
  },
  setItem: debounce(async (key: string, value: StorageValue<PersistedWindowState>): Promise<void> => {
    try {
      if (window.api && typeof window.api.storeSet === 'function') {
        await window.api.storeSet(key, JSON.stringify(value));
        console.log(`[Zustand Storage] Debounced setItem for key '${key}' executed.`);
      } else {
        console.warn(`[Zustand Storage] window.api.storeSet not available for key: ${key}`);
      }
    } catch (error) {
      console.error(`[Zustand Storage] Error setting item '${key}':`, error);
    }
  }, PERSIST_DEBOUNCE_MS, { maxWait: PERSIST_MAX_WAIT_MS }),
  removeItem: async (key: string): Promise<void> => {
    try {
      if (window.api && typeof window.api.storeRemove === 'function') {
        await window.api.storeRemove(key);
      } else {
        console.warn(`[Zustand Storage] window.api.storeRemove not available for key: ${key}`);
      }
    } catch (error) {
      console.error(`[Zustand Storage] Error removing item '${key}':`, error);
    }
  },
};

/** Cache for per-notebook store instances to ensure singleton per notebookId */
const notebookStores = new Map<string, StoreApi<WindowStoreState>>();

/**
 * Exporting notebookStores map to allow access for flushing on quit/unload.
 */
export { notebookStores };

/**
 * Factory function to create or retrieve a unique Zustand store instance for a given notebookId.
 * This store manages the state of windows within that notebook.
 *
 * @param notebookId The unique identifier of the notebook.
 * @returns A Zustand store API for the specified notebook's window state.
 */
export function createNotebookWindowStore(notebookId: string): StoreApi<WindowStoreState> {
  if (notebookStores.has(notebookId)) {
    return notebookStores.get(notebookId)!;
  }

  const highestZ = (wins: WindowMeta[]): number =>
    wins.reduce((max, w) => (w.zIndex > max ? w.zIndex : max), 99);

  const windowStoreSlice: StateCreator<WindowStoreState, [], [], WindowStoreState> = (
    set,
    get
  ) => ({
    windows: [],
    _hasHydrated: false, // Initial state for the hydration flag

    _setHasHydrated: (status) => {
      set({ _hasHydrated: status });
    },

    addWindow: (config) => {
      const { type, payload, preferredMeta = {} } = config;
      const currentWindows = get().windows;
      const newId = uuidv4();

      const defaultTitle = `New ${type.charAt(0).toUpperCase() + type.slice(1)} Window`;
      const defaultWidth = 500;
      const defaultHeight = 400;
      const defaultX = 50 + (currentWindows.length % 5) * 30; // Basic cascade for x
      const defaultY = 50 + (currentWindows.length % 5) * 30; // Basic cascade for y

      // Ensure valid payload for window types that require specific structure
      let validatedPayload: WindowPayload = payload || {};
      
      // Special handling for classic-browser windows
      if (type === 'classic-browser') {
        const classicPayload = payload as ClassicBrowserPayload | undefined;
        
        // Create a minimal placeholder payload
        // This will be immediately overwritten by the backend's authoritative state
        validatedPayload = {
          initialUrl: classicPayload?.initialUrl || 'about:blank',
          tabs: [], // Empty tabs array - backend will populate
          activeTabId: '', // Empty activeTabId - backend will populate
          freezeState: { type: 'ACTIVE' } // Start in active state
        } as ClassicBrowserPayload;
      }

      const newWindow: WindowMeta = {
        id: newId,
        type,
        payload: validatedPayload,
        title: preferredMeta.title ?? defaultTitle,
        x: preferredMeta.x ?? defaultX,
        y: preferredMeta.y ?? defaultY,
        width: preferredMeta.width ?? defaultWidth,
        height: preferredMeta.height ?? defaultHeight,
        zIndex: highestZ(currentWindows) + 1,
        isFocused: true,
      };

      set((state) => ({
        windows: [
          ...state.windows.map(w => w.isFocused ? { ...w, isFocused: false } : w),
          newWindow,
        ],
      }));
      return newId;
    },

    removeWindow: (id) => {
      set((state) => ({
        windows: state.windows.filter((w) => w.id !== id),
      }));
    },

    updateWindowProps: (id, propsToUpdate) => {
      set((state) => ({
        windows: state.windows.map((w) => {
          if (w.id !== id) return w;
          
          return { ...w, ...propsToUpdate };
        }),
      }));
    },

    setWindowFocus: async (id) => {
      const { windows } = get();
      const targetWindow = windows.find(w => w.id === id);
      const previouslyFocusedWindow = windows.find(w => w.isFocused && w.id !== id);

      if (!targetWindow) {
        logger.warn(`[WindowStore] setWindowFocus: Window ID ${id} not found. Aborting.`);
        return;
      }

      if (targetWindow.isFocused) {
        logger.debug(`[WindowStore] setWindowFocus: Window ${id} is already focused. No action needed.`);
        return;
      }

      logger.info(`[WindowStore] setWindowFocus: Switching focus from ${previouslyFocusedWindow?.id || 'none'} to ${id}`);

      // Perform atomic state update for all window properties
      // The controller hook will handle freeze/unfreeze logic based on focus changes
      const currentHighestZ = highestZ(windows);
      set((state) => ({
        windows: state.windows.map((w) => {
          if (w.id === id) {
            // Target window: set focused and update z-index
            return {
              ...w,
              isFocused: true,
              zIndex: currentHighestZ + 1
            };
          } else if (w.isFocused) {
            // Only create new object if this window was previously focused
            return {
              ...w,
              isFocused: false
            };
          } else {
            // Window wasn't focused before, return the same reference
            return w;
          }
        }),
      }));

      logger.info(`[WindowStore] Focus switched to window ${id}`);
    },

    minimizeWindow: (id) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, isMinimized: true, isFocused: false } : w
        ),
      }));
      console.log(`[WindowStore] Window ${id} minimized`);
    },

    restoreWindow: async (id) => {
      const targetWindow = get().windows.find(w => w.id === id);
      
      if (!targetWindow) {
        logger.warn(`[WindowStore] restoreWindow: Window ID ${id} not found. Aborting.`);
        return;
      }
      
      // First, unminimize the window
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, isMinimized: false } : w
        ),
      }));
      
      logger.info(`[WindowStore] Window ${id} restored from minimized state`);
      
      // Then, use setWindowFocus to handle focus and freeze/unfreeze logic
      await get().setWindowFocus(id);
    },

    toggleMinimize: async (id) => {
      const window = get().windows.find(w => w.id === id);
      if (!window) {
        console.warn(`[WindowStore toggleMinimize] Window ID ${id} not found.`);
        return;
      }
      
      if (window.isMinimized) {
        await get().restoreWindow(id);
      } else {
        get().minimizeWindow(id);
      }
    },
  });

  const store = create<WindowStoreState>()(
    persist<WindowStoreState, [], [], PersistedWindowState>(
      windowStoreSlice,
      {
        name: `notebook-layout-${notebookId}`,
        storage: notebookStateStorageAsync,
        partialize: (state: WindowStoreState): PersistedWindowState => ({
          windows: state.windows.map(win => {
            // Ensure payload is at least an empty object if undefined/null
            // This can help prevent issues if old data had missing payloads
            return { ...win, payload: win.payload || {} }; 
          })
        }),
        version: CURRENT_PERSIST_VERSION,
        migrate: (persistedState, version) => {
          console.log(`[Zustand Storage] Attempting migration for '${notebookId}'. Persisted version: ${version}, Current version: ${CURRENT_PERSIST_VERSION}`);
          let stateToMigrate = persistedState as unknown as PersistedWindowState; // Cast to PersistedWindowState for migration

          // If the persistedState is the raw WindowMeta[] (very old, unversioned, or from a faulty partialize)
          // This is a fallback, ideally partialize always returns { windows: [...] }
          if (Array.isArray(stateToMigrate) && version < CURRENT_PERSIST_VERSION) {
            console.warn(`[Zustand Storage] Detected raw array state for migration. Wrapping in { windows: ... }`);
            stateToMigrate = { windows: stateToMigrate };
          }

          // Ensure stateToMigrate has a windows property, if not, it's likely corrupt or unexpected.
          // Returning undefined will cause Zustand to ignore this persisted state.
          if (!stateToMigrate || typeof stateToMigrate.windows === 'undefined') {
            console.error(`[Zustand Storage] Migration error for '${notebookId}': Persisted state is missing 'windows' property or is null/undefined. Resetting to default.`);
            return { windows: [] }; // Return a default state instead of undefined
          }

          // Example Migration: v0 (or unversioned) -> v1
          // Assuming v0 might not have isMinimized/isMaximized or a guaranteed payload object
          if (version < 1) {
            console.log(`[Zustand Storage] Migrating '${notebookId}' from version < 1 to 1.`);
            stateToMigrate.windows = stateToMigrate.windows.map((w: WindowMeta) => ({
              ...w,
              isMinimized: typeof w.isMinimized === 'boolean' ? w.isMinimized : false,
              isMaximized: typeof w.isMaximized === 'boolean' ? w.isMaximized : false,
              // Ensure payload exists and is an object
              payload: w.payload && typeof w.payload === 'object' ? w.payload : {},
            }));
          }

          // Migration v1 -> v2: Add initialUrl to classic-browser windows
          if (version < 2) {
            console.log(`[Zustand Storage] Migrating '${notebookId}' from version < 2 to 2. Adding initialUrl to classic-browser windows.`);
            stateToMigrate.windows = stateToMigrate.windows.map((w: WindowMeta) => {
              if (w.type === 'classic-browser' && w.payload) {
                const payload = w.payload as ClassicBrowserPayload & { currentUrl?: string; requestedUrl?: string };
                // If initialUrl is missing, use currentUrl or requestedUrl as fallback
                if (!payload.initialUrl) {
                  payload.initialUrl = payload.currentUrl || payload.requestedUrl || 'about:blank';
                  console.log(`[Zustand Storage] Added initialUrl "${payload.initialUrl}" to classic-browser window ${w.id}`);
                }
              }
              return w;
            });
          }

          // Migration v2 -> v3: Ensure classic-browser windows have valid tabs structure
          if (version < 3) {
            console.log(`[Zustand Storage] Migrating '${notebookId}' from version < 3 to 3. Ensuring classic-browser windows have valid tabs structure.`);
            stateToMigrate.windows = stateToMigrate.windows.map((w: WindowMeta) => {
              if (w.type === 'classic-browser') {
                const payload = w.payload as ClassicBrowserPayload & { 
                  currentUrl?: string; 
                  requestedUrl?: string; 
                  currentTitle?: string; 
                  currentFaviconUrl?: string | null 
                };
                
                // If tabs array is missing or empty, create default tab structure
                if (!payload.tabs || !Array.isArray(payload.tabs) || payload.tabs.length === 0) {
                  const defaultTabId = uuidv4();
                  const defaultTab: TabState = {
                    id: defaultTabId,
                    url: payload.initialUrl || payload.currentUrl || payload.requestedUrl || 'about:blank',
                    title: payload.currentTitle || 'New Tab',
                    faviconUrl: payload.currentFaviconUrl || null,
                    isLoading: false,
                    canGoBack: false,
                    canGoForward: false,
                    error: null
                  };
                  
                  payload.tabs = [defaultTab];
                  payload.activeTabId = defaultTabId;
                  console.log(`[Zustand Storage] Added default tab structure to classic-browser window ${w.id}`);
                }
                
                // Ensure activeTabId is valid
                if (!payload.activeTabId || !payload.tabs.some((tab: TabState) => tab.id === payload.activeTabId)) {
                  payload.activeTabId = payload.tabs[0].id;
                  console.log(`[Zustand Storage] Fixed activeTabId for classic-browser window ${w.id}`);
                }
              }
              return w;
            });
          }

          // Migration v3 -> v4: Convert old freeze state to new state machine
          if (version < 4) {
            console.log(`[Zustand Storage] Migrating '${notebookId}' from version < 4 to 4. Converting freeze state to state machine.`);
            stateToMigrate.windows = stateToMigrate.windows.map((w: WindowMeta) => {
              if (w.type === 'classic-browser') {
                const payload = w.payload as ClassicBrowserPayload;
                
                // Add freezeState if missing
                if (!payload.freezeState) {
                  // Check if window has old freeze state
                  const wWithLegacy = w as WindowMeta & { isFrozen?: boolean; snapshotDataUrl?: string };
                  if (wWithLegacy.isFrozen && wWithLegacy.snapshotDataUrl) {
                    payload.freezeState = { type: 'FROZEN', snapshotUrl: wWithLegacy.snapshotDataUrl };
                    console.log(`[Zustand Storage] Converted frozen state for window ${w.id}`);
                  } else {
                    payload.freezeState = { type: 'ACTIVE' };
                    console.log(`[Zustand Storage] Added default ACTIVE freeze state for window ${w.id}`);
                  }
                }
                
                // Remove old properties from window meta
                const wMutable = w as WindowMeta & { isFrozen?: boolean; snapshotDataUrl?: string };
                delete wMutable.isFrozen;
                delete wMutable.snapshotDataUrl;
              }
              return w;
            });
          }

          console.log(`[Zustand Storage] Migration completed for '${notebookId}'.`);
          return stateToMigrate as PersistedWindowState;
        },
        onRehydrateStorage: () => {
          return (state, error) => {
            if (error) {
              console.error(`[Zustand Storage] Failed to rehydrate for ${notebookId}:`, error);
            }
            // Even on error, or if state is undefined (no persisted data), consider hydration attempt finished.
            console.log(`[Zustand Storage] Rehydration attempt finished for ${notebookId}. Persisted state found: ${!!state}`, {
              hasState: !!state,
              windowCount: state?.windows?.length || 0,
              windows: state?.windows?.map((w) => ({ id: w.id, type: w.type })) || []
            });
            const storeInstance = notebookStores.get(notebookId);
            if (storeInstance) {
              storeInstance.getState()._setHasHydrated(true);
            } else {
              // Fallback, though ideally storeInstance should be in the map.
              console.warn(`[Zustand Storage] Store for ${notebookId} not in cache during onRehydrateStorage, using local instance.`);
              store.getState()._setHasHydrated(true);
            }
          };
        }
      }
    )
  );

  notebookStores.set(notebookId, store);
  return store;
}

// Hook for easier consumption in React components
export const useWindowStore = (notebookId: string) => {
  const store = createNotebookWindowStore(notebookId);
  return useStore(store);
}; 