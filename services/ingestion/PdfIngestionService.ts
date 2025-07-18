import { promises as fs } from 'fs';
import * as path from 'path';
import { IngestionAiService } from './IngestionAIService';
// pdf-parse will be dynamically imported when needed to avoid test file loading
import { PdfDocumentSchema, type PdfDocument } from '../../shared/schemas/pdfSchemas';
import type { PdfIngestProgressPayload } from '../../shared/types';
import { BaseService } from '../base/BaseService';


// Import types from schemas instead of defining locally
import type { AiGeneratedContent } from '../../shared/schemas/aiSchemas';

export type PdfProgressCallback = (progress: Partial<PdfIngestProgressPayload>) => void;

interface PdfIngestionServiceDeps {
  ingestionAiService: IngestionAiService;
}

export class PdfIngestionService extends BaseService<PdfIngestionServiceDeps> {
  private progressCallback: PdfProgressCallback | null = null;

  constructor(deps: PdfIngestionServiceDeps) {
    super('PdfIngestionService', deps);
  }




  /**
   * Set a callback to receive progress updates
   * Used by the queue system to intercept progress
   */
  public setProgressCallback(callback: PdfProgressCallback | null): void {
    this.progressCallback = callback;
  }

  /**
   * Send progress update via callback
   */
  private sendProgress(payload: Partial<PdfIngestProgressPayload>): void {
    if (this.progressCallback) {
      this.progressCallback(payload);
    }
  }


  /**
   * Extract text and generate AI summary without persistence
   * For use by PdfIngestionWorker which handles persistence
   */
  async extractTextAndGenerateAiSummary(
    filePath: string,
    objectId: string
  ): Promise<{
    rawText: string;
    aiContent: AiGeneratedContent;
    pdfMetadata: any;
  }> {
    return this.execute('extractTextAndGenerateAiSummary', async () => {
      // Extract text
      const docs = await this.extractPdfText(filePath);
      const rawText = docs.map(doc => doc.pageContent).join('\n\n');
      
      if (!rawText || rawText.trim().length < 50) {
        throw new Error('TEXT_EXTRACTION_FAILED');
      }

      // Generate AI content using the standardized method
      const originalFileName = path.basename(filePath);
      const aiContent = await this.deps.ingestionAiService.generateObjectSummary(
        rawText,
        originalFileName,
        objectId
      );

      return {
        rawText,
        aiContent,
        pdfMetadata: docs[0]?.metadata || {}
      };
    });
  }

  /**
   * Extract text from PDF using pdf-parse (Node.js native solution)
   * Note: In production, you might want to use pdf.js or similar
   */
  private async extractPdfText(filePath: string): Promise<PdfDocument[]> {
    try {
      // Read the PDF file
      const dataBuffer = await fs.readFile(filePath);
      
      let data;
      
      // Skip workaround in test environment to avoid conflicts with mocks
      if (process.env.NODE_ENV === 'test') {
        const pdfParse = require('pdf-parse');
        data = await pdfParse(dataBuffer);
      } else {
        // Workaround for pdf-parse test file issue (production only)
        const originalReadFileSync = require('fs').readFileSync;
        require('fs').readFileSync = function(path: string, ...args: any[]) {
          if (path.includes('test/data/05-versions-space.pdf')) {
            return Buffer.from(''); // Return empty buffer for test file
          }
          return originalReadFileSync.apply(this, [path, ...args]);
        };
        
        try {
          const pdfParse = require('pdf-parse');
          data = await pdfParse(dataBuffer);
        } finally {
          // Restore original fs.readFileSync
          require('fs').readFileSync = originalReadFileSync;
        }
      }
      
      // Validate the extracted document
      const document: PdfDocument = {
        pageContent: data.text || '',
        metadata: {
          numpages: data.numpages,
          info: data.info,
          metadata: data.metadata,
          version: data.version
        }
      };
      
      const validationResult = PdfDocumentSchema.safeParse(document);
      if (!validationResult.success) {
        this.logWarn('PDF document validation warning:', validationResult.error);
        // Continue with unvalidated data but log the issue
      }
      
      return [validationResult.success ? validationResult.data : document];
    } catch (error) {
      this.logError('Failed to extract PDF text:', error);
      throw new Error('TEXT_EXTRACTION_FAILED');
    }
  }


}

// Factory function (deprecated - use dependency injection instead)
export const createPdfIngestionService = (deps: PdfIngestionServiceDeps): PdfIngestionService => {
  return new PdfIngestionService(deps);
};