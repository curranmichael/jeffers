import { create } from "zustand";
import { persist, PersistStorage, StorageValue } from "zustand/middleware";
import { debounce } from 'lodash-es';

/**
 * AppNavigationState defines the top-level navigation state for the application.
 * This manages only the home ↔ notebook switching, preserving all existing
 * window management, chat, and other sophisticated state systems.
 */
export interface AppNavigationState {
  /** Currently active notebook ID, null means home view */
  currentNotebookId: string | null;
  
  /** Opens a specific notebook by ID */
  openNotebook: (id: string) => void;
  
  /** Returns to home view */
  openHome: () => void;
  
  /** Hydration tracking (matches existing store patterns) */
  _hasHydrated: boolean;
  _setHasHydrated: (status: boolean) => void;
}

/**
 * Defines the shape of the state that is actually persisted.
 * Excludes hydration tracking properties.
 */
interface PersistedAppNavigationState {
  currentNotebookId: string | null;
}

const PERSIST_DEBOUNCE_MS = 750;
const PERSIST_MAX_WAIT_MS = 2000;
const CURRENT_PERSIST_VERSION = 1;

/**
 * Asynchronous storage adapter that bridges Zustand's persist() middleware
 * to our IPC-backed storage (window.api.storeGet/Set/Remove).
 * Matches the pattern from windowStoreFactory.ts exactly.
 */
export const appNavigationStorageAsync: PersistStorage<PersistedAppNavigationState> = {
  getItem: async (key: string): Promise<StorageValue<PersistedAppNavigationState> | null> => {
    try {
      if (window.api && typeof window.api.storeGet === 'function') {
        const stringValue = await window.api.storeGet(key);
        if (stringValue) {
          return JSON.parse(stringValue) as StorageValue<PersistedAppNavigationState>;
        }
      }
      console.warn(`[App Navigation Storage] window.api.storeGet not available or no value for key: ${key}`);
      return null;
    } catch (error) {
      console.error(`[App Navigation Storage] Error getting item '${key}':`, error);
      return null;
    }
  },
  setItem: debounce(async (key: string, value: StorageValue<PersistedAppNavigationState>): Promise<void> => {
    try {
      if (window.api && typeof window.api.storeSet === 'function') {
        await window.api.storeSet(key, JSON.stringify(value));
        console.log(`[App Navigation Storage] Debounced setItem for key '${key}' executed.`);
      } else {
        console.warn(`[App Navigation Storage] window.api.storeSet not available for key: ${key}`);
      }
    } catch (error) {
      console.error(`[App Navigation Storage] Error setting item '${key}':`, error);
    }
  }, PERSIST_DEBOUNCE_MS, { maxWait: PERSIST_MAX_WAIT_MS }),
  removeItem: async (key: string): Promise<void> => {
    try {
      if (window.api && typeof window.api.storeRemove === 'function') {
        await window.api.storeRemove(key);
      } else {
        console.warn(`[App Navigation Storage] window.api.storeRemove not available for key: ${key}`);
      }
    } catch (error) {
      console.error(`[App Navigation Storage] Error removing item '${key}':`, error);
    }
  },
};

/**
 * Creates the app navigation store following the same patterns as windowStoreFactory.ts
 */
export const useAppNavigationStore = create<AppNavigationState>()(
  persist<AppNavigationState, [], [], PersistedAppNavigationState>(
    (set) => ({
      currentNotebookId: null,
      _hasHydrated: false,

      _setHasHydrated: (status) => {
        set({ _hasHydrated: status });
      },

      openNotebook: (id) => {
        console.log(`[App Navigation] Opening notebook: ${id}`);
        set({ currentNotebookId: id });
      },

      openHome: () => {
        console.log(`[App Navigation] Returning to home`);
        set({ currentNotebookId: null });
      },
    }),
    {
      name: 'app-navigation',
      storage: appNavigationStorageAsync,
      partialize: (state: AppNavigationState): PersistedAppNavigationState => ({
        currentNotebookId: state.currentNotebookId,
      }),
      version: CURRENT_PERSIST_VERSION,
      migrate: (persistedState, version) => {
        console.log(`[App Navigation Storage] Attempting migration. Persisted version: ${version}, Current version: ${CURRENT_PERSIST_VERSION}`);
        
        const stateToMigrate = persistedState as unknown as PersistedAppNavigationState;

        // Validate persisted state structure
        if (!stateToMigrate || typeof stateToMigrate !== 'object') {
          console.warn(`[App Navigation Storage] Invalid persisted state, resetting to default.`);
          return { currentNotebookId: null };
        }

        // Ensure currentNotebookId is valid (string or null)
        if (stateToMigrate.currentNotebookId !== null && typeof stateToMigrate.currentNotebookId !== 'string') {
          console.warn(`[App Navigation Storage] Invalid currentNotebookId type, resetting to null.`);
          stateToMigrate.currentNotebookId = null;
        }

        console.log(`[App Navigation Storage] Migration completed.`);
        return stateToMigrate as PersistedAppNavigationState;
      },
      onRehydrateStorage: () => {
        return (state, error) => {
          if (error) {
            console.error(`[App Navigation Storage] Failed to rehydrate:`, error);
          }
          console.log(`[App Navigation Storage] Rehydration attempt finished. Persisted state found: ${!!state}`, {
            hasState: !!state,
            currentNotebookId: state?.currentNotebookId || null,
          });
          
          // Set hydration flag regardless of success/failure
          useAppNavigationStore.getState()._setHasHydrated(true);
        };
      }
    }
  )
);