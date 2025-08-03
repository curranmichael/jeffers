import { BaseService } from './base/BaseService';
import { ObjectModelCore } from '../models/ObjectModelCore';
import { ObjectAssociationModel } from '../models/ObjectAssociationModel';
import type { Database } from 'better-sqlite3';
import type { JeffersObject } from '../shared/types/object.types';

interface NotebookTSTPDeps {
  db: Database;
  objectModel: ObjectModelCore;
  objectAssociationModel: ObjectAssociationModel;
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
        tstp.tags.forEach(tag => allTags.add(tag));
        totalPropositions += tstp.propositions.length;

        // Handle composite objects (like tab groups)
        if (obj.childObjectIds && obj.childObjectIds.length > 0) {
          const childTSTPs = await this.extractChildrenTSTP(obj.childObjectIds);
          for (const childTSTP of childTSTPs) {
            objectTSTPs.push(childTSTP);
            childTSTP.tags.forEach(tag => allTags.add(tag));
            totalPropositions += childTSTP.propositions.length;
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
      tags,
      propositions
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
        for (const prop of obj.propositions) {
          allPropositions.push({
            objectId: obj.id,
            objectTitle: obj.title,
            type: prop.type,
            content: prop.content
          });
        }
      }

      return allPropositions;
    }, { notebookId });
  }
}