/**
 * Example SMRT Object
 *
 * This is a sample SMRT object to demonstrate the pattern.
 * Rename or replace this with your own objects.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'summarize'],
  },
  cli: { include: ['list', 'get', 'summarize'] },
})
export class Item extends SmrtObject {
  /** Item title */
  title: string = '';

  /** Item description */
  description: string = '';

  /** Status of the item */
  status: string = 'draft';

  /** When the item was published */
  publishedAt: Date | null = null;

  /**
   * AI-powered summarization
   */
  async summarize(): Promise<string> {
    return await this.do('Create a brief summary of this item');
  }

  /**
   * Mark item as published
   */
  async publish(): Promise<void> {
    this.status = 'published';
    this.publishedAt = new Date();
    await this.save();
  }
}
