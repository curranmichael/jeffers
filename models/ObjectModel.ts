import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db';
import { logger } from '../utils/logger';
import { JeffersObject, ObjectStatus, MediaType } from '../shared/types'; // Assuming these types exist/will exist
import Database from 'better-sqlite3';

// Define the structure returned by the database (snake_case)
interface ObjectRecord {
  id: string;
  object_type: string;
  source_uri: string | null;
  title: string | null;
  status: string;
  raw_content_ref: string | null;
  parsed_content_json: string | null;
  cleaned_text: string | null;
  error_info: string | null;
  parsed_at: string | null;
  created_at: string;
  updated_at: string;
  // PDF-specific fields
  file_hash: string | null;
  original_file_name: string | null;
  file_size_bytes: number | null;
  file_mime_type: string | null;
  internal_file_path: string | null;
  ai_generated_metadata: string | null;
  // Object-level summary fields
  summary: string | null;
  propositions_json: string | null;
  tags_json: string | null;
  summary_generated_at: string | null;
  // WOM support fields
  last_accessed_at: string | null;
  child_object_ids: string | null; // JSON array
}

// Type for the metadata subset fetched by getSourceContentDetailsByIds
export interface SourceMetadata {
    id: string;
    title: string | null;
    sourceUri: string | null;
    objectType: string;
}

// Helper to convert DB record (snake_case) to application object (camelCase)
// TODO: Consider a more robust mapping solution if needed
function mapRecordToObject(record: ObjectRecord): JeffersObject {
  return {
    id: record.id,
    objectType: record.object_type as MediaType,
    sourceUri: record.source_uri,
    title: record.title,
    status: record.status as ObjectStatus, // Type assertion
    rawContentRef: record.raw_content_ref,
    parsedContentJson: record.parsed_content_json,
    cleanedText: record.cleaned_text,
    errorInfo: record.error_info,
    parsedAt: record.parsed_at ? new Date(record.parsed_at) : undefined, // Convert ISO string to Date
    createdAt: new Date(record.created_at), // Convert ISO string to Date
    updatedAt: new Date(record.updated_at), // Convert ISO string to Date
    // PDF-specific fields
    fileHash: record.file_hash,
    originalFileName: record.original_file_name,
    fileSizeBytes: record.file_size_bytes,
    fileMimeType: record.file_mime_type,
    internalFilePath: record.internal_file_path,
    aiGeneratedMetadata: record.ai_generated_metadata,
    // Object-level summary fields
    summary: record.summary,
    propositionsJson: record.propositions_json,
    tagsJson: record.tags_json,
    summaryGeneratedAt: record.summary_generated_at ? new Date(record.summary_generated_at) : null,
    // WOM support fields
    lastAccessedAt: record.last_accessed_at ? new Date(record.last_accessed_at) : undefined,
    childObjectIds: record.child_object_ids ? JSON.parse(record.child_object_ids) : undefined,
  };
}

// Explicit mapping from JeffersObject keys (camelCase) to DB columns (snake_case)
const objectColumnMap: { [K in keyof Omit<JeffersObject, 'id' | 'createdAt' | 'updatedAt' | 'parsedAt' | 'summaryGeneratedAt' | 'lastAccessedAt'>]?: string } & { parsedAt?: string; summaryGeneratedAt?: string; lastAccessedAt?: string } = {
    objectType: 'object_type',
    sourceUri: 'source_uri',
    title: 'title',
    status: 'status',
    rawContentRef: 'raw_content_ref',
    parsedContentJson: 'parsed_content_json',
    cleanedText: 'cleaned_text',
    errorInfo: 'error_info',
    parsedAt: 'parsed_at', // Special handling needed for Date -> string
    // PDF-specific fields
    fileHash: 'file_hash',
    originalFileName: 'original_file_name',
    fileSizeBytes: 'file_size_bytes',
    fileMimeType: 'file_mime_type',
    internalFilePath: 'internal_file_path',
    aiGeneratedMetadata: 'ai_generated_metadata',
    // Object-level summary fields
    summary: 'summary',
    propositionsJson: 'propositions_json',
    tagsJson: 'tags_json',
    summaryGeneratedAt: 'summary_generated_at',
    // WOM support fields
    lastAccessedAt: 'last_accessed_at',
    childObjectIds: 'child_object_ids',
};


export class ObjectModel {
  private db: Database.Database;

  constructor(dbInstance?: Database.Database) {
    this.db = dbInstance ?? getDb(); // Use provided instance or default singleton
  }

  /**
   * Get the database instance for transaction support
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * Creates a new object record in the database.
   * Generates a UUID v4 for the new record.
   * Handles unique constraint violation on source_uri by returning existing object.
   * Underlying DB operation is synchronous.
   * @param data - The object data excluding id, createdAt, updatedAt.
   * @returns Promise resolving to the fully created JeffersObject including generated fields.
   */
  async create(
    data: Omit<JeffersObject, 'id' | 'createdAt' | 'updatedAt'> & { cleanedText?: string | null; }
  ): Promise<JeffersObject> {
    const db = this.db;
    const newId = uuidv4();
    const now = new Date().toISOString();
    const parsedAtISO = data.parsedAt instanceof Date ? data.parsedAt.toISOString() : data.parsedAt;

    const stmt = db.prepare(`
      INSERT INTO objects (
        id, object_type, source_uri, title, status,
        raw_content_ref, parsed_content_json, cleaned_text, error_info, parsed_at,
        file_hash, original_file_name, file_size_bytes, file_mime_type, internal_file_path, ai_generated_metadata,
        summary, propositions_json, tags_json, summary_generated_at,
        last_accessed_at, child_object_ids,
        created_at, updated_at
      )
      VALUES (
        @id, @objectType, @sourceUri, @title, @status,
        @rawContentRef, @parsedContentJson, @cleanedText, @errorInfo, @parsedAt,
        @fileHash, @originalFileName, @fileSizeBytes, @fileMimeType, @internalFilePath, @aiGeneratedMetadata,
        @summary, @propositionsJson, @tagsJson, @summaryGeneratedAt,
        @lastAccessedAt, @childObjectIds,
        @createdAt, @updatedAt
      )
    `);

    try {
      // Note: better-sqlite3 operations are synchronous
      stmt.run({
        id: newId,
        objectType: data.objectType,
        sourceUri: data.sourceUri ?? null,
        title: data.title ?? null,
        status: data.status ?? 'new',
        rawContentRef: data.rawContentRef ?? null,
        parsedContentJson: data.parsedContentJson ?? null,
        cleanedText: data.cleanedText ?? null, // Allow providing cleanedText
        errorInfo: data.errorInfo ?? null,
        parsedAt: parsedAtISO ?? null,
        // PDF-specific fields
        fileHash: data.fileHash ?? null,
        originalFileName: data.originalFileName ?? null,
        fileSizeBytes: data.fileSizeBytes ?? null,
        fileMimeType: data.fileMimeType ?? null,
        internalFilePath: data.internalFilePath ?? null,
        aiGeneratedMetadata: data.aiGeneratedMetadata ?? null,
        // Object-level summary fields
        summary: data.summary ?? null,
        propositionsJson: data.propositionsJson ?? null,
        tagsJson: data.tagsJson ?? null,
        summaryGeneratedAt: data.summaryGeneratedAt instanceof Date ? data.summaryGeneratedAt.toISOString() : data.summaryGeneratedAt ?? null,
        // WOM support fields
        lastAccessedAt: data.lastAccessedAt instanceof Date ? data.lastAccessedAt.toISOString() : data.lastAccessedAt ?? now,
        childObjectIds: data.childObjectIds ? JSON.stringify(data.childObjectIds) : null,
        createdAt: now,
        updatedAt: now,
      });
      logger.debug(`[ObjectModel] Created object with ID: ${newId}`);

      const newRecord = await this.getById(newId); // Fetch the created record
      if (!newRecord) {
          // This should not happen if insert succeeded and getById is correct
          throw new Error('Failed to retrieve newly created object');
      }
      return newRecord;

    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Check if the violation might be due to a non-null source_uri
        if (data.sourceUri) {
            logger.warn(`[ObjectModel] Attempted to create object with duplicate source_uri: ${data.sourceUri}. Fetching existing.`);
            const existing = await this.getBySourceUri(data.sourceUri); // Fetch existing by URI
            if (existing) return existing; // Return the existing object if found
            // If not found by URI despite constraint error, something else is wrong
             logger.error(`[ObjectModel] Unique constraint error for source_uri ${data.sourceUri}, but no existing object found by URI.`);
        }
        // If sourceUri was null, or getBySourceUri failed, re-throw the original error
        logger.error(`[ObjectModel] Unique constraint violation during create (source_uri: ${data.sourceUri}):`, error);
        throw error; // Re-throw original error
      } else {
          // Handle other errors
          logger.error(`[ObjectModel] Failed to create object for source URI ${data.sourceUri}:`, error);
          throw error;
      }
    }
  }

  /**
   * Creates a new object record in the database synchronously.
   * For use within transactions where async operations are not allowed.
   * Generates a UUID v4 for the new record.
   * @param data - The object data excluding id, createdAt, updatedAt.
   * @returns The created JeffersObject including generated fields.
   */
  createSync(
    data: Omit<JeffersObject, 'id' | 'createdAt' | 'updatedAt'> & { cleanedText?: string | null; }
  ): JeffersObject {
    const db = this.db;
    const newId = uuidv4();
    const now = new Date();
    const nowISO = now.toISOString();
    const parsedAtISO = data.parsedAt instanceof Date ? data.parsedAt.toISOString() : data.parsedAt;

    const stmt = db.prepare(`
      INSERT INTO objects (
        id, object_type, source_uri, title, status,
        raw_content_ref, parsed_content_json, cleaned_text, error_info, parsed_at,
        file_hash, original_file_name, file_size_bytes, file_mime_type, internal_file_path, ai_generated_metadata,
        summary, propositions_json, tags_json, summary_generated_at,
        last_accessed_at, child_object_ids,
        created_at, updated_at
      )
      VALUES (
        @id, @objectType, @sourceUri, @title, @status,
        @rawContentRef, @parsedContentJson, @cleanedText, @errorInfo, @parsedAt,
        @fileHash, @originalFileName, @fileSizeBytes, @fileMimeType, @internalFilePath, @aiGeneratedMetadata,
        @summary, @propositionsJson, @tagsJson, @summaryGeneratedAt,
        @lastAccessedAt, @childObjectIds,
        @createdAt, @updatedAt
      )
    `);

    try {
      stmt.run({
        id: newId,
        objectType: data.objectType,
        sourceUri: data.sourceUri ?? null,
        title: data.title ?? null,
        status: data.status ?? 'new',
        rawContentRef: data.rawContentRef ?? null,
        parsedContentJson: data.parsedContentJson ?? null,
        cleanedText: data.cleanedText ?? null,
        errorInfo: data.errorInfo ?? null,
        parsedAt: parsedAtISO ?? null,
        // PDF-specific fields
        fileHash: data.fileHash ?? null,
        originalFileName: data.originalFileName ?? null,
        fileSizeBytes: data.fileSizeBytes ?? null,
        fileMimeType: data.fileMimeType ?? null,
        internalFilePath: data.internalFilePath ?? null,
        aiGeneratedMetadata: data.aiGeneratedMetadata ?? null,
        // Object-level summary fields
        summary: data.summary ?? null,
        propositionsJson: data.propositionsJson ?? null,
        tagsJson: data.tagsJson ?? null,
        summaryGeneratedAt: data.summaryGeneratedAt instanceof Date ? data.summaryGeneratedAt.toISOString() : data.summaryGeneratedAt ?? null,
        // WOM support fields
        lastAccessedAt: data.lastAccessedAt instanceof Date ? data.lastAccessedAt.toISOString() : data.lastAccessedAt ?? nowISO,
        childObjectIds: data.childObjectIds ? JSON.stringify(data.childObjectIds) : null,
        createdAt: nowISO,
        updatedAt: nowISO,
      });
      
      logger.debug(`[ObjectModel] Created object synchronously with ID: ${newId}`);

      // Construct the JeffersObject to return without async fetch
      const createdObject: JeffersObject = {
        id: newId,
        objectType: data.objectType,
        sourceUri: data.sourceUri ?? null,
        title: data.title ?? null,
        status: (data.status ?? 'new') as ObjectStatus,
        rawContentRef: data.rawContentRef ?? null,
        parsedContentJson: data.parsedContentJson ?? null,
        cleanedText: data.cleanedText ?? null,
        errorInfo: data.errorInfo ?? null,
        parsedAt: data.parsedAt instanceof Date ? data.parsedAt : (parsedAtISO ? new Date(parsedAtISO) : undefined),
        createdAt: now,
        updatedAt: now,
        // PDF-specific fields
        fileHash: data.fileHash ?? null,
        originalFileName: data.originalFileName ?? null,
        fileSizeBytes: data.fileSizeBytes ?? null,
        fileMimeType: data.fileMimeType ?? null,
        internalFilePath: data.internalFilePath ?? null,
        aiGeneratedMetadata: data.aiGeneratedMetadata ?? null,
        // Object-level summary fields
        summary: data.summary ?? null,
        propositionsJson: data.propositionsJson ?? null,
        tagsJson: data.tagsJson ?? null,
        summaryGeneratedAt: data.summaryGeneratedAt ?? null,
      };

      return createdObject;

    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' && data.sourceUri) {
        logger.error(`[ObjectModel] Unique constraint violation in createSync for source_uri: ${data.sourceUri}`);
        throw new Error(`Object with source_uri '${data.sourceUri}' already exists`);
      }
      logger.error(`[ObjectModel] Failed to create object synchronously:`, error);
      throw error;
    }
  }

  /**
   * Updates specific fields of an object record.
   * Uses an explicit mapping to prevent invalid column names.
   * Automatically updates the updated_at timestamp via trigger.
   * Underlying DB operation is synchronous.
   * @param id - The UUID of the object to update.
   * @param updates - An object containing fields to update (e.g., { status: 'parsed', title: 'New Title' }).
   * @returns Promise resolving when the update is complete.
   */
  async update(id: string, updates: Partial<Omit<JeffersObject, 'id' | 'createdAt' | 'updatedAt'>>): Promise<void> {
    const db = this.db;
    const fieldsToSet: string[] = [];
    const params: Record<string, any> = { id };

    // Use explicit mapping to build SET clause safely
    for (const key in updates) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
            const typedKey = key as keyof typeof updates;

            // Explicitly skip trying to update sourceUri, as it should be immutable
            if (typedKey === 'sourceUri') {
                logger.debug(`[ObjectModel] Skipping update of immutable field: ${key}`);
                continue; // Go to the next key in the updates object
            }

            const dbColumn = objectColumnMap[typedKey];

            if (dbColumn) {
                fieldsToSet.push(`${dbColumn} = @${typedKey}`); // Use original key for param name
                // Handle Date object for parsedAt, summaryGeneratedAt, and lastAccessedAt specifically
                if (typedKey === 'parsedAt') {
                     params[typedKey] = updates.parsedAt instanceof Date ? updates.parsedAt.toISOString() : updates.parsedAt;
                } else if (typedKey === 'summaryGeneratedAt') {
                     params[typedKey] = updates.summaryGeneratedAt instanceof Date ? updates.summaryGeneratedAt.toISOString() : updates.summaryGeneratedAt;
                } else if (typedKey === 'lastAccessedAt') {
                     params[typedKey] = updates.lastAccessedAt instanceof Date ? updates.lastAccessedAt.toISOString() : updates.lastAccessedAt;
                } else if (typedKey === 'childObjectIds') {
                     params[typedKey] = updates.childObjectIds ? JSON.stringify(updates.childObjectIds) : null;
                } else {
                    params[typedKey] = updates[typedKey];
                }
            } else {
                logger.warn(`[ObjectModel] Update called with unmapped property: ${key}`);
            }
        }
    }

    if (fieldsToSet.length === 0) {
      logger.warn(`[ObjectModel] Update called for object ${id} with no valid fields to update.`);
      return; // Nothing to update
    }

    // Trigger handles updated_at
    const stmt = db.prepare(`
      UPDATE objects
      SET ${fieldsToSet.join(', ')}
      WHERE id = @id
    `);

    try {
      // Note: better-sqlite3 operations are synchronous
      const info = stmt.run(params);
      if (info.changes > 0) {
        logger.debug(`[ObjectModel] Updated object ${id}. Fields: ${Object.keys(updates).filter(k => objectColumnMap[k as keyof typeof objectColumnMap]).join(', ')}`);
      } else {
        logger.warn(`[ObjectModel] Attempted to update non-existent object ID ${id}`);
      }
    } catch (error) {
      logger.error(`[ObjectModel] Failed to update object ${id}:`, error);
      throw error;
    }
  }

  /**
   * Updates the status of an object, optionally setting parsed_at and error_info.
   * Clears error_info when status is not 'error'.
   * Underlying DB operation is synchronous.
   * @param id - The UUID of the object to update.
   * @param status - The new status.
   * @param parsedAt - Optional date when parsing was completed (often set with 'parsed' status).
   * @param errorInfo - Optional error details (only set if status is 'error').
   * @returns Promise resolving when the update is complete.
   */
  async updateStatus(id: string, status: ObjectStatus, parsedAt?: Date, errorInfo?: string | null): Promise<void> {
    const db = this.db;
    const fieldsToSet: string[] = ['status = @status'];
    const params: Record<string, any> = { id, status };

    // Only add parsed_at if provided
    if (parsedAt) {
        fieldsToSet.push('parsed_at = @parsedAt');
        params.parsedAt = parsedAt.toISOString();
    }

    // Handle error_info based on the new status
    fieldsToSet.push('error_info = @errorInfo');
    if (status === 'error') {
        // Set errorInfo if status is 'error', use provided value or null
        params.errorInfo = errorInfo ?? null;
    } else {
        // Clear errorInfo if status is not 'error'
        params.errorInfo = null;
    }

    // Trigger handles updated_at
    const stmt = db.prepare(`
      UPDATE objects
      SET ${fieldsToSet.join(', ')}
      WHERE id = @id
    `);

    try {
      // Note: better-sqlite3 operations are synchronous
      const info = stmt.run(params);
      if (info.changes > 0) {
        logger.debug(`[ObjectModel] Updated status for object ${id} to ${status}. Error info ${params.errorInfo === null ? 'cleared' : 'set'}.`);
      } else {
        logger.warn(`[ObjectModel] Attempted to update status for non-existent object ID ${id}`);
      }
    } catch (error) {
      logger.error(`[ObjectModel] Failed to update status for object ${id}:`, error);
      throw error;
    }
  }

  /**
   * Finds objects matching a list of statuses.
   * NOTE: Vulnerable to >999 variable limit. Implement batching if needed.
   * Underlying DB operation is synchronous.
   * @param statuses - An array of ObjectStatus values to query for.
   * @returns Promise resolving to an array of JeffersObject instances.
   */
  async findByStatus(statuses: ObjectStatus[]): Promise<JeffersObject[]> {
    const db = this.db;
    if (!statuses || statuses.length === 0) {
        return [];
    }

    // Create placeholders for the IN clause (?, ?, ?)
    const placeholders = statuses.map(() => '?').join(', ');
    const stmt = db.prepare(`
        SELECT id, object_type, source_uri, title, status, raw_content_ref, parsed_content_json, error_info, 
               created_at, updated_at, cleaned_text, parsed_at, file_hash, original_file_name, file_size_bytes
        FROM objects
        WHERE status IN (${placeholders})
        ORDER BY created_at ASC -- Process older items first potentially
    `);

    try {
        // Type assertion: better-sqlite3 returns any[], we expect this structure.
        const rows = stmt.all(...statuses) as any[];
        logger.debug(`[ObjectModel] Found ${rows.length} objects with statuses: ${statuses.join(', ')}`);
        
        // Map database rows to JeffersObject instances
        return rows.map(row => ({
            id: row.id,
            objectType: row.object_type,
            sourceUri: row.source_uri,
            title: row.title,
            status: row.status,
            rawContentRef: row.raw_content_ref,
            parsedContentJson: row.parsed_content_json,
            errorInfo: row.error_info,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            cleanedText: row.cleaned_text,
            parsedAt: row.parsed_at ? new Date(row.parsed_at) : undefined,
            fileHash: row.file_hash,
            originalFileName: row.original_file_name,
            fileSizeBytes: row.file_size_bytes
        }));
    } catch (error) {
        logger.error(`[ObjectModel] Failed to find objects by status:`, error);
        throw error;
    }
  }

  /**
   * Retrieves objects that are ready for the next stage of processing.
   * Currently targets objects with status 'parsed'.
   * Underlying DB operation is synchronous.
   * @param limit - Maximum number of objects to retrieve.
   * @returns Promise resolving to an array of JeffersObject ready for processing.
   */
  async getProcessableObjects(limit: number): Promise<JeffersObject[]> {
    const db = this.db;
    // Initially fetch 'parsed' objects for chunking/embedding
    const targetStatus: ObjectStatus = 'parsed';
    const stmt = db.prepare(`
      SELECT * FROM objects
      WHERE status = ?
      ORDER BY created_at ASC -- Process oldest first
      LIMIT ?
    `);

    try {
      const records = stmt.all(targetStatus, limit) as ObjectRecord[];
      logger.debug(`[ObjectModel] Found ${records.length} objects with status '${targetStatus}' to process.`);
      return records.map(mapRecordToObject);
    } catch (error) {
      logger.error(`[ObjectModel] Failed to get processable objects with status ${targetStatus}:`, error);
      throw error;
    }
  }

   /**
   * Retrieves a single object by its UUID.
   * Underlying DB operation is synchronous.
   * @param id - The UUID of the object.
   * @returns Promise resolving to the JeffersObject or null if not found.
   */
  async getById(id: string): Promise<JeffersObject | null> {
    const db = this.db;
    const stmt = db.prepare('SELECT * FROM objects WHERE id = ?');
    try {
        const record = stmt.get(id) as ObjectRecord | undefined;
        return record ? mapRecordToObject(record) : null; // Simplified return
    } catch (error) {
        logger.error(`[ObjectModel] Failed to get object by ID ${id}:`, error);
        throw error;
    }
  }

   /**
   * Retrieves a single object by its source URI.
   * Assumes source_uri is UNIQUE (or returns the first match).
   * Underlying DB operation is synchronous.
   * @param uri - The source URI of the object.
   * @returns Promise resolving to the JeffersObject or null if not found.
   */
  async getBySourceUri(uri: string): Promise<JeffersObject | null> {
    const db = this.db;
    const stmt = db.prepare('SELECT * FROM objects WHERE source_uri = ?');
     try {
        const record = stmt.get(uri) as ObjectRecord | undefined;
        return record ? mapRecordToObject(record) : null; // Simplified return
    } catch (error) {
        logger.error(`[ObjectModel] Failed to get object by source URI ${uri}:`, error);
        throw error;
    }
  }

  /**
   * Deletes an object by its ID.
   * This only deletes from the objects table - related data should be handled by the service layer.
   * @param id - The UUID of the object to delete.
   * @returns void
   */
  deleteById(id: string): void {
      const db = this.db;
      const stmt = db.prepare('DELETE FROM objects WHERE id = ?');
      try {
          const info = stmt.run(id);
          if (info.changes > 0) {
              logger.debug(`[ObjectModel] Deleted object with ID: ${id}`);
          } else {
              logger.warn(`[ObjectModel] Attempted to delete non-existent object ID ${id}`);
          }
      } catch (error) {
          logger.error(`[ObjectModel] Failed to delete object by ID ${id}:`, error);
          throw error;
      }
  }

  /**
   * Deletes multiple objects by their IDs.
   * This only deletes from the objects table - related data should be handled by the service layer.
   * Handles batching for large numbers of IDs.
   * @param ids - Array of object UUIDs to delete.
   * @returns void
   */
  deleteByIds(ids: string[]): void {
      if (ids.length === 0) {
          return;
      }

      const BATCH_SIZE = 500; // Safe under SQL variable limit
      let totalDeleted = 0;

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => '?').join(', ');
          const stmt = this.db.prepare(`DELETE FROM objects WHERE id IN (${placeholders})`);

          try {
              const result = stmt.run(...batch);
              totalDeleted += result.changes;
              logger.debug(`[ObjectModel] Deleted ${result.changes} objects in batch of ${batch.length}`);
          } catch (error) {
              logger.error('[ObjectModel] Failed to delete objects by IDs:', error);
              throw error;
          }
      }

      logger.info(`[ObjectModel] Deleted ${totalDeleted} total objects from ${ids.length} IDs`);
  }

  /**
   * Fetches minimal metadata for the given source object IDs.
   * Returns a Map keyed by object ID for easy lookup.
   * NOTE: Vulnerable to >999 variable limit. Implement batching if needed.
   * Underlying DB operation is synchronous.
   * @param objectIds Array of source object UUIDs.
   * @returns Promise resolving to a Map<string, SourceMetadata>.
   */
  async getSourceContentDetailsByIds(objectIds: string[]): Promise<Map<string, SourceMetadata>> {
      const resultsMap = new Map<string, SourceMetadata>();
      if (!objectIds || objectIds.length === 0) {
          return resultsMap;
      }

      const placeholders = objectIds.map(() => '?').join(', ');
      const query = `SELECT id, title, source_uri, object_type FROM objects WHERE id IN (${placeholders})`;

      try {
          logger.debug(`[ObjectModel] Fetching details for object IDs: [${objectIds.slice(0, 5).join(', ')}...] (${objectIds.length} total)`);
          const stmt = this.db.prepare(query);
          // Use SPREAD operator (...) for multiple bindings
          const rows = stmt.all(...objectIds) as { id: string; title: string | null; source_uri: string | null; object_type: string }[];

          logger.debug(`[ObjectModel] Found ${rows.length} details for ${objectIds.length} IDs.`);

          rows.forEach(row => {
              resultsMap.set(row.id, {
                  id: row.id,
                  title: row.title,
                  sourceUri: row.source_uri,
                  objectType: row.object_type,
              });
          });

          return resultsMap;

      } catch (error: any) {
          logger.error(`[ObjectModel] Failed to fetch details for object IDs: [${objectIds.slice(0, 5).join(', ')}...]`, error);
          throw new Error(`Database error fetching source content details: ${error.message}`);
      }
  }

  /**
   * Counts objects by status efficiently using SQL COUNT(*).
   * Handles both single status and array of statuses.
   * Underlying DB operation is synchronous.
   * @param status - A single ObjectStatus or array of ObjectStatus values to count.
   * @returns Promise resolving to the count of objects matching the status(es).
   */
  async countObjectsByStatus(status: ObjectStatus | ObjectStatus[]): Promise<number> {
    const db = this.db;
    const statuses = Array.isArray(status) ? status : [status];
    
    if (statuses.length === 0) {
      return 0;
    }

    // Create placeholders for the IN clause (?, ?, ?)
    const placeholders = statuses.map(() => '?').join(', ');
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM objects
      WHERE status IN (${placeholders})
    `);

    try {
      const result = stmt.get(...statuses) as { count: number };
      logger.debug(`[ObjectModel] Counted ${result.count} objects with status(es): ${statuses.join(', ')}`);
      return result.count;
    } catch (error) {
      logger.error(`[ObjectModel] Failed to count objects by status(es) (${statuses.join(', ')}):`, error);
      throw error;
    }
  }

  /**
   * Finds an object by its file hash (for PDF deduplication).
   * @param fileHash - The SHA256 hash of the file.
   * @returns Promise resolving to the JeffersObject or null if not found.
   */
  async findByFileHash(fileHash: string): Promise<JeffersObject | null> {
    const db = this.db;
    const stmt = db.prepare('SELECT * FROM objects WHERE file_hash = ?');
    try {
      const record = stmt.get(fileHash) as ObjectRecord | undefined;
      return record ? mapRecordToObject(record) : null;
    } catch (error) {
      logger.error(`[ObjectModel] Failed to find object by file hash ${fileHash}:`, error);
      throw error;
    }
  }

  /**
   * Checks if an object exists with the given source URI.
   * Efficient check using SELECT 1 for minimal data transfer.
   * @param sourceUri - The source URI to check.
   * @returns Promise resolving to true if an object exists with this URI, false otherwise.
   */
  async existsBySourceUri(sourceUri: string): Promise<boolean> {
    const db = this.db;
    const stmt = db.prepare('SELECT 1 FROM objects WHERE source_uri = ? LIMIT 1');
    try {
      const record = stmt.get(sourceUri);
      const exists = record !== undefined;
      logger.debug(`[ObjectModel] Checked existence of source URI ${sourceUri}: ${exists}`);
      return exists;
    } catch (error) {
      logger.error(`[ObjectModel] Failed to check existence by source URI ${sourceUri}:`, error);
      throw error;
    }
  }

  /**
   * Updates the last_accessed_at timestamp for an object.
   * @param objectId - The UUID of the object to update.
   * @returns void
   */
  updateLastAccessed(objectId: string): void {
    const db = this.db;
    const stmt = db.prepare(`
      UPDATE objects
      SET last_accessed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    try {
      const info = stmt.run(objectId);
      if (info.changes > 0) {
        logger.debug(`[ObjectModel] Updated last_accessed_at for object ${objectId}`);
      } else {
        logger.warn(`[ObjectModel] Attempted to update last_accessed_at for non-existent object ID ${objectId}`);
      }
    } catch (error) {
      logger.error(`[ObjectModel] Failed to update last_accessed_at for object ${objectId}:`, error);
      throw error;
    }
  }

  /**
   * Gets the child object IDs for a composite object.
   * @param objectId - The UUID of the object.
   * @returns Array of child object IDs, or empty array if none.
   */
  getChildIds(objectId: string): string[] {
    const db = this.db;
    const stmt = db.prepare('SELECT child_object_ids FROM objects WHERE id = ?');
    
    try {
      const record = stmt.get(objectId) as { child_object_ids: string | null } | undefined;
      if (!record || !record.child_object_ids) {
        return [];
      }
      return JSON.parse(record.child_object_ids);
    } catch (error) {
      logger.error(`[ObjectModel] Failed to get child IDs for object ${objectId}:`, error);
      throw error;
    }
  }

  /**
   * Updates the child object IDs for a composite object.
   * @param objectId - The UUID of the object to update.
   * @param childIds - Array of child object IDs.
   * @returns void
   */
  updateChildIds(objectId: string, childIds: string[]): void {
    const db = this.db;
    const stmt = db.prepare(`
      UPDATE objects
      SET child_object_ids = ?
      WHERE id = ?
    `);

    try {
      const childIdsJson = childIds.length > 0 ? JSON.stringify(childIds) : null;
      const info = stmt.run(childIdsJson, objectId);
      if (info.changes > 0) {
        logger.debug(`[ObjectModel] Updated child IDs for object ${objectId}: ${childIds.length} children`);
      } else {
        logger.warn(`[ObjectModel] Attempted to update child IDs for non-existent object ID ${objectId}`);
      }
    } catch (error) {
      logger.error(`[ObjectModel] Failed to update child IDs for object ${objectId}:`, error);
      throw error;
    }
  }

  /**
   * Finds an object by its source URI.
   * @param sourceUri - The source URI to search for.
   * @returns The JeffersObject if found, null otherwise.
   */
  async findBySourceUri(sourceUri: string): Promise<JeffersObject | null> {
    return this.getBySourceUri(sourceUri);
  }

  /**
   * Creates or updates an object based on source URI.
   * If an object with the given source URI exists, updates it; otherwise creates a new one.
   * @param data - The object data.
   * @returns The created or updated JeffersObject.
   */
  async createOrUpdate(
    data: Omit<JeffersObject, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<JeffersObject> {
    if (data.sourceUri) {
      const existing = await this.findBySourceUri(data.sourceUri);
      if (existing) {
        // If it exists, create a clean update payload.
        // The 'update' method correctly handles mapping camelCase keys to snake_case columns.
        const updatePayload: Partial<JeffersObject> = {
          ...data,
          lastAccessedAt: new Date(), // Always update the access time
        };
        // The 'update' method is smart enough to ignore immutable fields like sourceUri.
        await this.update(existing.id, updatePayload);
        return (await this.getById(existing.id))!;
      }
    }
    // If it doesn't exist, create it.
    return this.create(data);
  }


  // TODO: Add other methods as needed (e.g., listAll, updateTitle, etc.)
} 