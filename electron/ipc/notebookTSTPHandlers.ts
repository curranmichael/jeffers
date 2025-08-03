import { IpcMain } from 'electron';
import { NotebookTSTPService } from '../../services/NotebookTSTPService';
import {
  NOTEBOOK_GET_TSTP,
  NOTEBOOK_GET_SUMMARY,
  NOTEBOOK_GET_TAGS,
  NOTEBOOK_GET_PROPOSITIONS,
  NOTEBOOK_GENERATE_TSTP
} from '../../shared/ipcChannels';
import { logger } from '../../utils/logger';

export function registerNotebookTSTPHandlers(
  ipcMain: IpcMain,
  notebookTSTPService: NotebookTSTPService
) {
  // Get full TSTP data for a notebook
  ipcMain.handle(
    NOTEBOOK_GET_TSTP,
    async (event, notebookId: string) => {
      try {
        logger.debug('[NotebookTSTP] Getting TSTP for notebook:', notebookId);
        return await notebookTSTPService.getNotebookTSTP(notebookId);
      } catch (error) {
        logger.error('[NotebookTSTP] Error getting TSTP:', error);
        throw error;
      }
    }
  );

  // Get aggregated summary for a notebook
  ipcMain.handle(
    NOTEBOOK_GET_SUMMARY,
    async (event, notebookId: string) => {
      try {
        logger.debug('[NotebookTSTP] Getting summary for notebook:', notebookId);
        return await notebookTSTPService.getNotebookSummary(notebookId);
      } catch (error) {
        logger.error('[NotebookTSTP] Error getting summary:', error);
        throw error;
      }
    }
  );

  // Get aggregated tags for a notebook
  ipcMain.handle(
    NOTEBOOK_GET_TAGS,
    async (event, notebookId: string) => {
      try {
        logger.debug('[NotebookTSTP] Getting tags for notebook:', notebookId);
        return await notebookTSTPService.getNotebookTags(notebookId);
      } catch (error) {
        logger.error('[NotebookTSTP] Error getting tags:', error);
        throw error;
      }
    }
  );

  // Get all propositions from a notebook
  ipcMain.handle(
    NOTEBOOK_GET_PROPOSITIONS,
    async (event, notebookId: string) => {
      try {
        logger.debug('[NotebookTSTP] Getting propositions for notebook:', notebookId);
        return await notebookTSTPService.getNotebookPropositions(notebookId);
      } catch (error) {
        logger.error('[NotebookTSTP] Error getting propositions:', error);
        throw error;
      }
    }
  );

  // Generate and save TSTP data for a notebook
  ipcMain.handle(
    NOTEBOOK_GENERATE_TSTP,
    async (event, notebookId: string) => {
      try {
        logger.debug('[NotebookTSTP] Generating TSTP for notebook:', notebookId);
        return await notebookTSTPService.generateAndSaveTSTP(notebookId);
      } catch (error) {
        logger.error('[NotebookTSTP] Error generating TSTP:', error);
        throw error;
      }
    }
  );

  logger.info('[NotebookTSTP] IPC handlers registered');
}