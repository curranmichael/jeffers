import { IpcMain, IpcMainInvokeEvent } from 'electron';
import { OBJECT_GET_BY_ID, OBJECT_DELETE, OBJECT_DELETE_BY_SOURCE_URI } from '../../shared/ipcChannels';
import { ObjectModelCore } from '../../models/ObjectModelCore';
import { ObjectService } from '../../services/ObjectService';
import { ClassicBrowserService } from '../../services/browser/ClassicBrowserService';
import { JeffersObject, DeleteResult } from '../../shared/types';
import { logger } from '../../utils/logger';

export function registerObjectHandlers(
  ipcMain: IpcMain, 
  objectModelCore: ObjectModelCore, 
  objectService?: ObjectService,
  classicBrowserService?: ClassicBrowserService
) {
  // Get object by ID
  ipcMain.handle(OBJECT_GET_BY_ID, async (
    event: IpcMainInvokeEvent,
    objectId: string
  ): Promise<JeffersObject | null> => {
    try {
      logger.info(`[ObjectHandlers] Getting object by ID: ${objectId}`);
      const object = await objectModelCore.getById(objectId);
      
      if (!object) {
        logger.warn(`[ObjectHandlers] Object not found: ${objectId}`);
        return null;
      }
      
      logger.info(`[ObjectHandlers] Found object: ${object.title} (type: ${object.objectType})`);
      return object;
    } catch (error) {
      logger.error('[ObjectHandlers] Error getting object:', error);
      throw error;
    }
  });

  // Delete objects by IDs
  ipcMain.handle(OBJECT_DELETE, async (
    event: IpcMainInvokeEvent,
    objectIds: string[]
  ): Promise<DeleteResult> => {
    try {
      logger.info(`[ObjectHandlers] Deleting ${objectIds.length} objects`);
      
      if (objectService) {
        // Use provided service
        const result = await objectService.deleteObjects(objectIds);
        logger.info(`[ObjectHandlers] Deletion complete. Successful: ${result.successful.length}, Failed: ${result.failed.length}`);
        return result;
      } else {
        // Fallback to direct model operations
        logger.warn('[ObjectHandlers] ObjectService not available from registry, cannot create fallback instance');
        // Since ObjectService now requires the split models, we can't create a fallback instance
        // Just return an error result
        return {
          successful: [],
          failed: objectIds,
          notFound: []
        };
      }
    } catch (error) {
      logger.error('[ObjectHandlers] Error deleting objects:', error);
      throw error;
    }
  });

  // Delete object by source URI
  ipcMain.handle(OBJECT_DELETE_BY_SOURCE_URI, async (
    event: IpcMainInvokeEvent,
    { windowId, sourceUri }: { windowId: string; sourceUri: string }
  ): Promise<DeleteResult> => {
    try {
      logger.info(`[ObjectHandlers] Deleting object by source URI: ${sourceUri}`);
      
      if (objectService) {
        // Use provided service
        const result = await objectService.deleteObjectBySourceUri(sourceUri);
        
        // If deletion was successful and we have classicBrowserService, refresh the browser state
        if (result.successful.length > 0 && classicBrowserService) {
          logger.info(`[ObjectHandlers] Refreshing browser state for window ${windowId}`);
          await classicBrowserService.refreshTabState(windowId);
        }
        
        logger.info(`[ObjectHandlers] Deletion by URI complete. Successful: ${result.successful.length}, Failed: ${result.failed.length}`);
        return result;
      } else {
        // Fallback to direct model operations
        logger.warn('[ObjectHandlers] ObjectService not available from registry, cannot create fallback instance');
        // Since ObjectService now requires the split models, we can't create a fallback instance
        // Just return an error result
        return {
          successful: [],
          failed: [sourceUri],
          notFound: []
        };
      }
    } catch (error) {
      logger.error('[ObjectHandlers] Error deleting object by source URI:', error);
      throw error;
    }
  });
}