/**
 * EventType model - Defines types/categories of events
 *
 * Examples: 'basketball-game', 'concert', 'conference', 'goal', 'period'
 */

import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';
import type { EventTypeOptions } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class EventType extends SmrtObject {
  // id, slug, name inherited from SmrtObject
  description = ''; // Optional description
  schema = ''; // JSON schema for event metadata (stored as text)
  participantSchema = ''; // JSON schema for participant metadata (stored as text)

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EventTypeOptions = {}) {
    super(options);
    if (options.description !== undefined)
      this.description = options.description;

    // Handle schema - can be object or JSON string
    if (options.schema !== undefined) {
      if (typeof options.schema === 'string') {
        this.schema = options.schema;
      } else {
        this.schema = JSON.stringify(options.schema);
      }
    }

    // Handle participant schema
    if (options.participantSchema !== undefined) {
      if (typeof options.participantSchema === 'string') {
        this.participantSchema = options.participantSchema;
      } else {
        this.participantSchema = JSON.stringify(options.participantSchema);
      }
    }

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get schema as parsed object
   *
   * @returns Parsed schema object or empty object if no schema
   */
  getSchema(): Record<string, any> {
    if (!this.schema) return {};
    try {
      return JSON.parse(this.schema);
    } catch {
      return {};
    }
  }

  /**
   * Set schema from object
   *
   * @param data - Schema object to store
   */
  setSchema(data: Record<string, any>): void {
    this.schema = JSON.stringify(data);
  }

  /**
   * Get participant schema as parsed object
   *
   * @returns Parsed participant schema object or empty object
   */
  getParticipantSchema(): Record<string, any> {
    if (!this.participantSchema) return {};
    try {
      return JSON.parse(this.participantSchema);
    } catch {
      return {};
    }
  }

  /**
   * Set participant schema from object
   *
   * @param data - Participant schema object to store
   */
  setParticipantSchema(data: Record<string, any>): void {
    this.participantSchema = JSON.stringify(data);
  }

  /**
   * Convenience method for slug-based lookup
   *
   * @param slug - The slug to search for
   * @returns EventType instance or null if not found
   */
  static async getBySlug(slug: string): Promise<EventType | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
