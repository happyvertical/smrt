/**
 * Dispatch Model - Persistent dispatch message for inter-agent communication
 *
 * Dispatches are stored in the _smrt_dispatch system table and represent
 * messages sent between agents. They support async processing with retry logic.
 */

import { makeId } from '@happyvertical/utils';
import type { DispatchMetadata, DispatchStatus } from '../types.js';

/**
 * Raw dispatch data as stored in the database
 */
export interface DispatchData {
  id: string;
  type: string;
  source: string;
  source_id: string | null;
  payload: string | null;
  status: DispatchStatus;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
  processed_by: string | null;
  target_subscriber: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Dispatch model for inter-agent communication
 */
export class Dispatch {
  /** Table name for this model */
  static readonly tableName = '_smrt_dispatch';

  /** Unique identifier */
  id: string;

  /** Signal type (e.g., 'campaign.completed') */
  type: string;

  /** Emitting agent name */
  source: string;

  /** Emitting agent instance ID */
  sourceId: string;

  /** Dispatch payload */
  payload: Record<string, unknown>;

  /** Current status */
  status: DispatchStatus;

  /** Number of processing attempts */
  attempts: number;

  /** Last error message if failed */
  lastError: string;

  /** When the dispatch was processed */
  processedAt: Date | null;

  /** Which subscriber processed it */
  processedBy: string;

  /** Target subscriber for fan-out delivery (null for compete mode) */
  targetSubscriber: string | null;

  /** Additional metadata */
  metadata: Record<string, unknown>;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;

  constructor(data: Partial<DispatchData> = {}) {
    this.id = data.id || makeId();
    this.type = data.type || '';
    this.source = data.source || '';
    this.sourceId = data.source_id || '';
    this.status = (data.status as DispatchStatus) || 'pending';
    this.attempts = data.attempts || 0;
    this.lastError = data.last_error || '';
    this.processedBy = data.processed_by || '';
    this.targetSubscriber = data.target_subscriber || null;
    this.createdAt = data.created_at ? new Date(data.created_at) : new Date();
    this.updatedAt = data.updated_at ? new Date(data.updated_at) : new Date();
    this.processedAt = data.processed_at ? new Date(data.processed_at) : null;

    // Parse JSON fields
    this.payload = data.payload ? JSON.parse(data.payload) : {};
    this.metadata = data.metadata ? JSON.parse(data.metadata) : {};
  }

  /**
   * Create a Dispatch from a database row
   */
  static fromRow(row: DispatchData): Dispatch {
    return new Dispatch(row);
  }

  /**
   * Convert to database row format
   */
  toRow(): DispatchData {
    return {
      id: this.id,
      type: this.type,
      source: this.source,
      source_id: this.sourceId || null,
      payload: JSON.stringify(this.payload),
      status: this.status,
      attempts: this.attempts,
      last_error: this.lastError || null,
      processed_at: this.processedAt?.toISOString() || null,
      processed_by: this.processedBy || null,
      target_subscriber: this.targetSubscriber || null,
      metadata: JSON.stringify(this.metadata),
      created_at: this.createdAt.toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Get dispatch metadata for handlers
   */
  getMetadata(): DispatchMetadata {
    return {
      id: this.id,
      type: this.type,
      source: this.source,
      sourceId: this.sourceId,
      createdAt: this.createdAt,
      attempts: this.attempts,
      metadata: this.metadata,
    };
  }

  /**
   * Mark as processing
   */
  markProcessing(): void {
    this.status = 'processing';
    this.attempts += 1;
    this.updatedAt = new Date();
  }

  /**
   * Mark as completed
   */
  markCompleted(processedBy: string): void {
    this.status = 'completed';
    this.processedAt = new Date();
    this.processedBy = processedBy;
    this.lastError = '';
    this.updatedAt = new Date();
  }

  /**
   * Mark as failed
   */
  markFailed(error: string): void {
    this.status = 'failed';
    this.lastError = error;
    this.updatedAt = new Date();
  }

  /**
   * Reset to pending for retry
   */
  resetForRetry(): void {
    this.status = 'pending';
    this.updatedAt = new Date();
  }

  /**
   * Check if this dispatch can be retried
   */
  canRetry(maxAttempts: number): boolean {
    return this.status === 'failed' && this.attempts < maxAttempts;
  }
}
