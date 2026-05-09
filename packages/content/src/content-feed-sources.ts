import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  ContentFeedSource,
  type ContentFeedSourceStatus,
} from './content-feed-source';

export interface ContentFeedSourceCollectionOptions
  extends SmrtCollectionOptions {}

export class ContentFeedSourceCollection extends SmrtCollection<ContentFeedSource> {
  static readonly _itemClass = ContentFeedSource;

  async findActive(tenantId?: string | null): Promise<ContentFeedSource[]> {
    const where: Record<string, unknown> = { status: 'active' };
    if (tenantId !== undefined) where.tenantId = tenantId;
    return this.list({ where, orderBy: 'name ASC' });
  }

  async findByStatus(
    status: ContentFeedSourceStatus,
    tenantId?: string | null,
  ): Promise<ContentFeedSource[]> {
    const where: Record<string, unknown> = { status };
    if (tenantId !== undefined) where.tenantId = tenantId;
    return this.list({ where, orderBy: 'name ASC' });
  }

  async findByFeedUrl(
    feedUrl: string,
    tenantId?: string | null,
  ): Promise<ContentFeedSource | null> {
    const where: Record<string, unknown> = { feedUrl };
    if (tenantId !== undefined) where.tenantId = tenantId;
    const rows = await this.list({ where, limit: 1 });
    return rows[0] ?? null;
  }
}
