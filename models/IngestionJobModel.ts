import { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import type { 
  JobType, 
  JobStatus, 
  JobProgress, 
  JobSpecificData, 
  IngestionJob as SharedIngestionJob, // Use alias to avoid naming conflict with local interface
  CreateIngestionJobParams as SharedCreateIngestionJobParams, 
  UpdateIngestionJobParams as SharedUpdateIngestionJobParams 
} from '../shared/types';

// Type definitions
// MOVED TO shared/types.d.ts: JobType, JobStatus, JobProgress, JobSpecificData

// Database row type
interface IngestionJobRow {
  id: string;
  job_type: string;
  source_identifier: string;
  original_file_name: string | null;
  status: string;
  priority: number;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  progress: string | null;
  error_info: string | null;
  failed_stage: string | null;
  // Add new fields for chunking service coordination to the row type
  chunking_status: string | null; // Stored as string in DB
  chunking_error_info: string | null;
  job_specific_data: string | null;
  related_object_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// Local interface mapping directly to shared type for clarity
export interface IngestionJob extends SharedIngestionJob {}
export interface CreateIngestionJobParams extends SharedCreateIngestionJobParams {}
export interface UpdateIngestionJobParams extends SharedUpdateIngestionJobParams {}

export class IngestionJobModel {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    logger.info('[IngestionJobModel] Initialized.');
  }

  /**
   * Create a new ingestion job
   */
  create(params: CreateIngestionJobParams): IngestionJob {
    const id = uuidv4();
    const now = new Date().toISOString();
    
    logger.debug('[IngestionJobModel] Creating job', { id, ...params });

    try {
      const stmt = this.db.prepare(`
        INSERT INTO ingestion_jobs (
          id, job_type, source_identifier, original_file_name,
          status, priority, attempts, job_specific_data,
          created_at, updated_at
        ) VALUES (
          $id, $jobType, $sourceIdentifier, $originalFileName,
          'queued', $priority, 0, $jobSpecificData,
          $createdAt, $updatedAt
        )
      `);

      stmt.run({
        id,
        jobType: params.jobType,
        sourceIdentifier: params.sourceIdentifier,
        originalFileName: params.originalFileName || null,
        priority: params.priority || 0,
        jobSpecificData: params.jobSpecificData ? JSON.stringify(params.jobSpecificData) : null,
        createdAt: now,
        updatedAt: now
      });

      const job = this.getById(id);
      if (!job) {
        throw new Error('Failed to retrieve created job');
      }

      logger.info('[IngestionJobModel] Job created', { id, jobType: params.jobType });
      return job;
    } catch (error) {
      logger.error('[IngestionJobModel] Error creating job:', error);
      throw error;
    }
  }

  /**
   * Get a job by ID
   */
  getById(id: string): IngestionJob | null {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM ingestion_jobs WHERE id = ?
      `);

      const row = stmt.get(id) as IngestionJobRow | undefined;
      if (!row) {
        return null;
      }

      return this.rowToJob(row);
    } catch (error) {
      logger.error('[IngestionJobModel] Error getting job by ID:', error);
      throw error;
    }
  }

  /**
   * Get next jobs to process (ordered by priority and creation time)
   */
  getNextJobs(limit: number = 10, jobTypes?: JobType[]): IngestionJob[] {
    try {
      const now = new Date().toISOString();
      let query = `
        SELECT * FROM ingestion_jobs 
        WHERE (status = 'queued' OR (status = 'retry_pending' AND next_attempt_at <= ?))
      `;

      const params: any[] = [now];

      if (jobTypes && jobTypes.length > 0) {
        const placeholders = jobTypes.map(() => '?').join(',');
        query += ` AND job_type IN (${placeholders})`;
        params.push(...jobTypes);
      }

      query += ` ORDER BY priority DESC, created_at ASC LIMIT ?`;
      params.push(limit);

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as IngestionJobRow[];

      return rows.map(row => this.rowToJob(row));
    } catch (error) {
      logger.error('[IngestionJobModel] Error getting next jobs:', error);
      throw error;
    }
  }

  /**
   * Update a job
   */
  update(id: string, params: UpdateIngestionJobParams): boolean {
    logger.debug('[IngestionJobModel] Updating job', { id, ...params });

    try {
      const updates: string[] = [];
      const values: any = { id };

      if (params.status !== undefined) {
        updates.push('status = $status');
        values.status = params.status;
      }

      if (params.chunking_status !== undefined) {
        updates.push('chunking_status = $chunking_status');
        values.chunking_status = params.chunking_status;
      }

      if (params.chunking_error_info !== undefined) {
        updates.push('chunking_error_info = $chunking_error_info');
        values.chunking_error_info = params.chunking_error_info;
      }

      if (params.attempts !== undefined) {
        updates.push('attempts = $attempts');
        values.attempts = params.attempts;
      }

      if (params.lastAttemptAt !== undefined) {
        updates.push('last_attempt_at = $lastAttemptAt');
        values.lastAttemptAt = params.lastAttemptAt;
      }

      if (params.nextAttemptAt !== undefined) {
        updates.push('next_attempt_at = $nextAttemptAt');
        values.nextAttemptAt = params.nextAttemptAt;
      }

      if (params.progress !== undefined) {
        updates.push('progress = $progress');
        values.progress = JSON.stringify(params.progress);
      }

      if (params.errorInfo !== undefined) {
        updates.push('error_info = $errorInfo');
        values.errorInfo = params.errorInfo;
      }

      if (params.failedStage !== undefined) {
        updates.push('failed_stage = $failedStage');
        values.failedStage = params.failedStage;
      }

      if (params.relatedObjectId !== undefined) {
        updates.push('related_object_id = $relatedObjectId');
        values.relatedObjectId = params.relatedObjectId;
      }

      if (params.completedAt !== undefined) {
        updates.push('completed_at = $completedAt');
        values.completedAt = params.completedAt;
      }

      if (updates.length === 0) {
        return true; // Nothing to update
      }

      const stmt = this.db.prepare(`
        UPDATE ingestion_jobs 
        SET ${updates.join(', ')}
        WHERE id = $id
      `);

      const result = stmt.run(values);
      
      // Log at debug level for routine updates, info level for important state changes
      if (params.status === 'failed' || params.status === 'completed') {
        logger.info('[IngestionJobModel] Job updated', { id, changes: result.changes, ...params });
      } else {
        logger.debug('[IngestionJobModel] Job updated', { id, changes: result.changes, fields: Object.keys(params) });
      }
      return result.changes > 0;
    } catch (error) {
      logger.error('[IngestionJobModel] Error updating job:', error);
      throw error;
    }
  }

  /**
   * Mark a job as started (transition from queued/retry_pending to processing_source)
   */
  markAsStarted(id: string): boolean {
    const row = this.db.prepare('SELECT attempts FROM ingestion_jobs WHERE id = ?').get(id) as { attempts: number } | undefined;
    return this.update(id, {
      status: 'processing_source',
      lastAttemptAt: new Date().toISOString(),
      attempts: (row?.attempts ?? 0) + 1
    });
  }

  /**
   * Mark a job as completed
   */
  markAsCompleted(id: string, relatedObjectId?: string): boolean {
    return this.update(id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      relatedObjectId: relatedObjectId
    });
  }

  /**
   * Mark a job as failed with retry
   */
  markAsRetryable(id: string, errorInfo: string, failedStage: string, nextAttemptDelayMs: number = 60000): boolean {
    // Use UTC-safe arithmetic by working with milliseconds
    const nextAttemptMs = Date.now() + nextAttemptDelayMs;
    const nextAttemptAt = new Date(nextAttemptMs).toISOString();
    
    return this.update(id, {
      status: 'retry_pending',
      errorInfo,
      failedStage,
      nextAttemptAt
    });
  }

  /**
   * Mark a job as permanently failed
   */
  markAsFailed(id: string, errorInfo: string, failedStage: string): boolean {
    return this.update(id, {
      status: 'failed',
      errorInfo,
      failedStage,
      completedAt: new Date().toISOString()
    });
  }

  /**
   * Get jobs by status
   */
  getByStatus(status: JobStatus, limit?: number): IngestionJob[] {
    try {
      let query = `SELECT * FROM ingestion_jobs WHERE status = ? ORDER BY created_at DESC`;
      if (limit) {
        query += ` LIMIT ${limit}`;
      }

      const stmt = this.db.prepare(query);
      const rows = stmt.all(status) as IngestionJobRow[];

      return rows.map(row => this.rowToJob(row));
    } catch (error) {
      logger.error('[IngestionJobModel] Error getting jobs by status:', error);
      throw error;
    }
  }

  /**
   * Get job statistics
   */
  getStats(): Record<JobStatus, number> {
    try {
      const stmt = this.db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM ingestion_jobs 
        GROUP BY status
      `);

      const rows = stmt.all() as Array<{ status: JobStatus; count: number }>;
      const stats: Record<JobStatus, number> = {} as Record<JobStatus, number>;

      rows.forEach(row => {
        stats[row.status] = row.count;
      });

      return stats;
    } catch (error) {
      logger.error('[IngestionJobModel] Error getting stats:', error);
      throw error;
    }
  }

  /**
   * Clean up old completed/failed jobs
   */
  cleanupOldJobs(daysToKeep: number = 30): number {
    try {
      // Use UTC-safe arithmetic by working with milliseconds
      const cutoffMs = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
      const cutoffTime = new Date(cutoffMs).toISOString();
      
      const stmt = this.db.prepare(`
        DELETE FROM ingestion_jobs 
        WHERE status IN ('completed', 'failed', 'cancelled') 
        AND completed_at < ?
      `);

      const result = stmt.run(cutoffTime);
      
      logger.info('[IngestionJobModel] Cleaned up old jobs', { deleted: result.changes });
      return result.changes;
    } catch (error) {
      logger.error('[IngestionJobModel] Error cleaning up old jobs:', error);
      throw error;
    }
  }

  /**
   * Convert database row to IngestionJob object
   */
  private rowToJob(row: IngestionJobRow): IngestionJob {
    let progress: JobProgress | undefined;
    let jobSpecificData: JobSpecificData | undefined;
    
    // Safe JSON parsing with error handling
    if (row.progress) {
      try {
        progress = JSON.parse(row.progress);
      } catch (error) {
        logger.error('[IngestionJobModel] Failed to parse progress JSON:', error);
        // progress remains undefined
      }
    }
    
    if (row.job_specific_data) {
      try {
        jobSpecificData = JSON.parse(row.job_specific_data);
      } catch (error) {
        logger.error('[IngestionJobModel] Failed to parse jobSpecificData JSON:', error);
        // jobSpecificData remains undefined
      }
    }
    
    return {
      id: row.id,
      jobType: row.job_type as JobType,
      sourceIdentifier: row.source_identifier,
      originalFileName: row.original_file_name || undefined,
      status: row.status as JobStatus,
      priority: row.priority,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at || undefined,
      nextAttemptAt: row.next_attempt_at || undefined,
      progress,
      errorInfo: row.error_info || undefined,
      failedStage: row.failed_stage || undefined,
      chunking_status: (row.chunking_status as IngestionJob['chunking_status']) || undefined,
      chunking_error_info: row.chunking_error_info || undefined,
      jobSpecificData,
      relatedObjectId: row.related_object_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined
    };
  }

  /**
   * Find a job that is awaiting chunking for a specific related object ID.
   * @param relatedObjectId The ID of the object that has been parsed.
   * @returns The IngestionJob or null if not found.
   */
  findJobAwaitingChunking(relatedObjectId: string): IngestionJob | null {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM ingestion_jobs
        WHERE related_object_id = ? 
        AND (chunking_status = 'pending' OR chunking_status IS NULL)
        AND status = 'vectorizing'
        LIMIT 1
      `);
      const row = stmt.get(relatedObjectId) as IngestionJobRow | undefined;
      return row ? this.rowToJob(row) : null;
    } catch (error) {
      logger.error('[IngestionJobModel] Error finding job awaiting chunking:', error);
      throw error;
    }
  }

  /**
   * Delete all failed jobs
   * @returns Number of deleted jobs
   */
  deleteFailedJobs(): number {
    try {
      // First, let's see what failed jobs exist
      const checkStmt = this.db.prepare(`
        SELECT id, source_identifier, error_info, created_at 
        FROM ingestion_jobs 
        WHERE status = 'failed'
        LIMIT 10
      `);
      const failedJobs = checkStmt.all() as IngestionJobRow[];
      
      if (failedJobs.length > 0) {
        logger.info('[IngestionJobModel] Found failed jobs to delete:', {
          count: failedJobs.length,
          samples: failedJobs.slice(0, 3).map(j => ({
            id: j.id,
            source: j.source_identifier.substring(0, 50) + '...',
            created: j.created_at
          }))
        });
      }
      
      const stmt = this.db.prepare(`
        DELETE FROM ingestion_jobs WHERE status = 'failed'
      `);
      
      const result = stmt.run();
      
      if (result.changes > 0) {
        logger.info('[IngestionJobModel] Deleted failed jobs', { count: result.changes });
      }
      
      return result.changes;
    } catch (error) {
      logger.error('[IngestionJobModel] Error deleting failed jobs:', error);
      throw error;
    }
  }
}