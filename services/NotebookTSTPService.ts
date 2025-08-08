import { BaseService } from './base/BaseService';
import { ObjectModelCore } from '../models/ObjectModelCore';
import { ObjectAssociationModel } from '../models/ObjectAssociationModel';
import { NotebookModel } from '../models/NotebookModel';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Database } from 'better-sqlite3';
import type { JeffersObject } from '../shared/types/object.types';

interface NotebookTSTPDeps {
  db: Database;
  objectModel: ObjectModelCore;
  objectAssociationModel: ObjectAssociationModel;
  notebookModel: NotebookModel;
  llm: BaseChatModel;
}

interface ObjectTSTP {
  id: string;
  title: string;
  summary: string | null;
  tags: string[];
  propositions: Array<{
    type: 'main' | 'supporting' | 'action';
    content: string;
  }>;
}

interface NotebookTSTP {
  notebookId: string;
  objects: ObjectTSTP[];
  aggregatedTags: string[];
  totalPropositions: number;
}

export class NotebookTSTPService extends BaseService<NotebookTSTPDeps> {
  constructor(deps: NotebookTSTPDeps) {
    super('NotebookTSTPService', deps);
  }

  async getNotebookTSTP(notebookId: string): Promise<NotebookTSTP> {
    return this.execute('getNotebookTSTP', async () => {
      // Get all object IDs in the notebook
      const objectIds = this.deps.objectAssociationModel.getObjectIdsForNotebook(notebookId);
      
      if (objectIds.length === 0) {
        return {
          notebookId,
          objects: [],
          aggregatedTags: [],
          totalPropositions: 0
        };
      }

      // Fetch all objects in parallel
      const objects = await Promise.all(
        objectIds.map(id => this.deps.objectModel.getById(id))
      );

      // Process each object to extract TSTP
      const objectTSTPs: ObjectTSTP[] = [];
      const allTags = new Set<string>();
      let totalPropositions = 0;

      for (const obj of objects) {
        if (!obj) continue;

        const tstp = await this.extractObjectTSTP(obj);
        objectTSTPs.push(tstp);

        // Aggregate tags
        if (Array.isArray(tstp.tags)) {
          tstp.tags.forEach(tag => allTags.add(tag));
        }
        totalPropositions += Array.isArray(tstp.propositions) ? tstp.propositions.length : 0;

        // Handle composite objects (like tab groups)
        if (obj.childObjectIds && obj.childObjectIds.length > 0) {
          const childTSTPs = await this.extractChildrenTSTP(obj.childObjectIds);
          for (const childTSTP of childTSTPs) {
            objectTSTPs.push(childTSTP);
            if (Array.isArray(childTSTP.tags)) {
              childTSTP.tags.forEach(tag => allTags.add(tag));
            }
            totalPropositions += Array.isArray(childTSTP.propositions) ? childTSTP.propositions.length : 0;
          }
        }
      }

      return {
        notebookId,
        objects: objectTSTPs,
        aggregatedTags: Array.from(allTags).sort(),
        totalPropositions
      };
    }, { notebookId });
  }

  private async extractObjectTSTP(obj: JeffersObject): Promise<ObjectTSTP> {
    // Safely parse JSON fields
    const tags = this.safeParseJSON<string[]>(obj.tagsJson, []);
    const propositions = this.safeParseJSON<Array<{
      type: 'main' | 'supporting' | 'action';
      content: string;
    }>>(obj.propositionsJson, []);

    return {
      id: obj.id,
      title: obj.title || 'Untitled',
      summary: obj.summary ?? null,
      tags: Array.isArray(tags) ? tags : [],
      propositions: Array.isArray(propositions) ? propositions : []
    };
  }

  private async extractChildrenTSTP(childIds: string[]): Promise<ObjectTSTP[]> {
    const children = await Promise.all(
      childIds.map(id => this.deps.objectModel.getById(id))
    );

    const childTSTPs: ObjectTSTP[] = [];
    for (const child of children) {
      if (!child) continue;
      const tstp = await this.extractObjectTSTP(child);
      childTSTPs.push(tstp);
    }

    return childTSTPs;
  }

  private safeParseJSON<T>(jsonString: string | null | undefined, defaultValue: T): T {
    if (!jsonString) return defaultValue;
    
    try {
      const parsed = JSON.parse(jsonString);
      return parsed as T;
    } catch (error) {
      this.logWarn(`Failed to parse JSON: ${error}`);
      return defaultValue;
    }
  }

  async getNotebookSummary(notebookId: string): Promise<string | null> {
    return this.execute('getNotebookSummary', async () => {
      const tstp = await this.getNotebookTSTP(notebookId);
      
      if (tstp.objects.length === 0) {
        return null;
      }

      // Collect all summaries
      const summaries = tstp.objects
        .map(obj => obj.summary)
        .filter((summary): summary is string => summary !== null && summary.length > 0);

      if (summaries.length === 0) {
        return null;
      }

      // For now, concatenate summaries with some structure
      // In the future, this could use AI to synthesize a cohesive summary
      return summaries.join('\n\n');
    }, { notebookId });
  }

  async getNotebookTags(notebookId: string): Promise<string[]> {
    return this.execute('getNotebookTags', async () => {
      const tstp = await this.getNotebookTSTP(notebookId);
      return tstp.aggregatedTags;
    }, { notebookId });
  }

  async getNotebookPropositions(notebookId: string): Promise<Array<{
    objectId: string;
    objectTitle: string;
    type: 'main' | 'supporting' | 'action';
    content: string;
  }>> {
    return this.execute('getNotebookPropositions', async () => {
      const tstp = await this.getNotebookTSTP(notebookId);
      
      const allPropositions: Array<{
        objectId: string;
        objectTitle: string;
        type: 'main' | 'supporting' | 'action';
        content: string;
      }> = [];

      for (const obj of tstp.objects) {
        // Ensure propositions is an array before iterating
        if (Array.isArray(obj.propositions)) {
          for (const prop of obj.propositions) {
            allPropositions.push({
              objectId: obj.id,
              objectTitle: obj.title,
              type: prop.type,
              content: prop.content
            });
          }
        }
      }

      return allPropositions;
    }, { notebookId });
  }

  /**
   * Generates TSTP data for a notebook and saves it to the database.
   * This aggregates all tags, summaries, and propositions from objects in the notebook.
   * @param notebookId - The UUID of the notebook to process.
   * @returns Promise resolving to success status and optional error message.
   */
  async generateAndSaveTSTP(notebookId: string): Promise<{ success: boolean; error?: string }> {
    return this.execute('generateAndSaveTSTP', async () => {
      try {
        // Get the full TSTP data
        const tstp = await this.getNotebookTSTP(notebookId);
        
        if (tstp.objects.length === 0) {
          this.logInfo(`No objects found in notebook ${notebookId}, skipping TSTP generation`);
          return { success: true };
        }

        // Get the notebook title for context
        const notebook = await this.deps.notebookModel.getById(notebookId);
        const notebookTitle = notebook?.title || 'Untitled Notebook';

        // Generate AI synthesis of the notebook
        const synthesis = await this.generateNotebookSynthesis(tstp.objects, notebookTitle);

        // Collect all propositions with metadata
        const propositions = [];
        for (const obj of tstp.objects) {
          // Ensure propositions is an array before iterating
          if (Array.isArray(obj.propositions)) {
            for (const prop of obj.propositions) {
              propositions.push({
                objectId: obj.id,
                objectTitle: obj.title,
                type: prop.type,
                content: prop.content
              });
            }
          }
        }

        // Add notebook-level propositions from synthesis
        if (Array.isArray(synthesis.propositions)) {
          for (const prop of synthesis.propositions) {
            propositions.push({
              objectId: notebookId,
              objectTitle: notebookTitle,
              type: prop.type,
              content: prop.content
            });
          }
        }

        // Save to database with AI-generated summary
        const updatedNotebook = await this.deps.notebookModel.updateTSTP(notebookId, {
          summary: synthesis.summary,
          tags: synthesis.tags,
          propositions
        });

        if (!updatedNotebook) {
          return { 
            success: false, 
            error: `Notebook ${notebookId} not found` 
          };
        }

        this.logInfo(`Successfully generated and saved TSTP for notebook ${notebookId}:`, {
          tagCount: synthesis.tags.length,
          propositionCount: propositions.length,
          summaryLength: synthesis.summary.length
        });

        return { success: true };
      } catch (error) {
        this.logError(`Failed to generate TSTP for notebook ${notebookId}`, error);
        return { 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        };
      }
    }, { notebookId });
  }

  /**
   * Generates an AI synthesis of notebook content
   * Based on the pattern from CompositeObjectEnrichmentService
   */
  private async generateNotebookSynthesis(
    objects: ObjectTSTP[], 
    notebookTitle: string
  ): Promise<{ summary: string; tags: string[]; propositions: Array<{ type: string; content: string }> }> {
    try {
      // Build the prompt with all object TSTP data
      const prompt = this.buildNotebookSynthesisPrompt(objects, notebookTitle);
      
      // Invoke the LLM
      const response = await this.deps.llm.invoke(prompt);
      
      // Parse the response
      const synthesis = this.parseNotebookSynthesisResponse(response.content);
      
      this.logInfo(`Generated AI synthesis for notebook with ${objects.length} objects`);
      
      return synthesis;
    } catch (error) {
      this.logError('Failed to generate notebook synthesis', error);
      
      // Fallback to simple concatenation if AI synthesis fails
      const summaries = objects
        .map(obj => obj.summary)
        .filter((summary): summary is string => summary !== null && summary.length > 0);
      
      return {
        summary: summaries.join('\n\n'),
        tags: Array.from(new Set(objects.flatMap(obj => obj.tags))),
        propositions: []
      };
    }
  }

  /**
   * Builds the prompt for notebook synthesis
   * Adapted from CompositeObjectEnrichmentService
   */
  private buildNotebookSynthesisPrompt(objects: ObjectTSTP[], notebookTitle: string): string {
    return `You are analyzing a notebook containing multiple documents to generate a cohesive summary that captures the essence of the entire collection.

Notebook Title: ${notebookTitle}

Documents in this notebook:
${JSON.stringify(objects, null, 2)}

Generate notebook metadata in the following JSON format:
{
  "summary": "A single sentence capturing the essence of this notebook (MAXIMUM 12 WORDS)",
  "tags": ["select the 8-12 most relevant tags from all documents", "add 2-3 meta-tags that capture the notebook's theme"],
  "propositions": [
    {"type": "main", "content": "A key insight that emerges from the collection as a whole"},
    {"type": "main", "content": "Another major theme or conclusion spanning multiple documents"},
    {"type": "supporting", "content": "Supporting evidence or patterns observed across documents"},
    {"type": "action", "content": "Recommended actions based on the collective content (if applicable)"}
  ]
}

CRITICAL REQUIREMENTS:
- The summary MUST be exactly ONE sentence
- The summary MUST be 12 words or fewer
- Make every word count - be precise
- Capture the core theme or purpose of the notebook
- Tags array contains the most relevant tags (deduplicated) plus meta-tags
- Propositions capture cross-cutting insights and connections between documents`;
  }

  /**
   * Parses the AI response for notebook synthesis
   * Adapted from CompositeObjectEnrichmentService
   */
  private parseNotebookSynthesisResponse(content: any): { 
    summary: string; 
    tags: string[]; 
    propositions: Array<{ type: string; content: string }> 
  } {
    const defaultResponse = {
      summary: 'A collection of related documents',
      tags: [],
      propositions: []
    };

    try {
      // Handle string response
      if (typeof content === 'string') {
        // Try JSON parsing (with or without markdown code blocks)
        try {
          const cleanedContent = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
          const parsed = JSON.parse(cleanedContent);
          
          if (parsed.summary) {
            return {
              summary: parsed.summary,
              tags: Array.isArray(parsed.tags) ? parsed.tags : [],
              propositions: Array.isArray(parsed.propositions) ? parsed.propositions : []
            };
          }
        } catch {
          // JSON parsing failed, try to extract what we can
          this.logWarn('Failed to parse notebook synthesis as JSON, using fallback parsing');
        }
        
        // For non-JSON responses, try to extract summary
        const lines = content.split('\n').map(line => line.trim()).filter(line => line);
        const summaryStartIndex = lines.findIndex(line => 
          line.match(/^(?:summary:)/i)
        );
        
        let summary = defaultResponse.summary;
        if (summaryStartIndex !== -1) {
          const summaryLines = lines.slice(summaryStartIndex);
          summary = summaryLines
            .map(line => line.replace(/^(?:summary:)\s*/i, ''))
            .join(' ')
            .trim();
        } else if (lines.length > 0) {
          // If no explicit summary marker, use the whole content as summary
          summary = lines.join(' ');
        }
        
        return { summary, tags: [], propositions: [] };
      }
      
      // Handle AIMessage object format
      if (content && typeof content === 'object' && 'content' in content) {
        return this.parseNotebookSynthesisResponse(content.content);
      }
      
      return defaultResponse;
    } catch (error) {
      this.logError('Failed to parse notebook synthesis response', error);
      return defaultResponse;
    }
  }
}