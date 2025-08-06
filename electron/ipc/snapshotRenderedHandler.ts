import { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ClassicBrowserViewManager } from '../../services/browser/ClassicBrowserViewManager';
import { BROWSER_SNAPSHOT_RENDERED } from '../../shared/ipcChannels';
import { logger } from '../../utils/logger';

/**
 * Registers the handler for confirming that a snapshot has been rendered in the DOM.
 * This allows the main process to hide the WebContentsView only after the snapshot is visible.
 * 
 * @param ipcMain The IpcMain instance
 * @param viewManager The ClassicBrowserViewManager instance
 */
export function registerSnapshotRenderedHandler(
  ipcMain: IpcMain,
  viewManager: ClassicBrowserViewManager
) {
  ipcMain.handle(BROWSER_SNAPSHOT_RENDERED, async (event: IpcMainInvokeEvent, { windowId }: { windowId: string }) => {
    try {
      logger.debug(`[SnapshotRendered] Snapshot rendered confirmation for windowId: ${windowId}`);
      
      // Get the frozen view and hide it now that the snapshot is visible
      const frozenView = viewManager.getFrozenView(windowId);
      if (frozenView) {
        viewManager.setViewVisibility(frozenView, false);
        logger.debug(`[SnapshotRendered] Hidden WebContentsView for windowId: ${windowId}`);
        return { success: true };
      } else {
        logger.warn(`[SnapshotRendered] No frozen view found for windowId: ${windowId}`);
        return { success: false };
      }
    } catch (error) {
      logger.error(`[SnapshotRendered] Error handling snapshot rendered for windowId ${windowId}:`, error);
      throw error;
    }
  });
}