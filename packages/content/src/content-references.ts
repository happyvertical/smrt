import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentReference } from './content-reference';

async function ensureContentReferencesTable(db: {
  query: (...args: any[]) => Promise<unknown>;
}) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS content_references (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      tenant_id TEXT,
      source_id TEXT,
      target_id TEXT
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS content_references_source_id_target_id_idx
    ON content_references (source_id, target_id)
  `);
}

export interface ContentReferencesOptions extends SmrtCollectionOptions {}

export class ContentReferences extends SmrtCollection<ContentReference> {
  static readonly _itemClass = ContentReference;

  async getForSource(sourceId: string): Promise<ContentReference[]> {
    await ensureContentReferencesTable(this.db);
    return (await this.list({
      where: { sourceId },
      orderBy: 'created_at ASC',
    })) as ContentReference[];
  }

  async getForTarget(targetId: string): Promise<ContentReference[]> {
    await ensureContentReferencesTable(this.db);
    return (await this.list({
      where: { targetId },
      orderBy: 'created_at ASC',
    })) as ContentReference[];
  }

  async link(
    sourceId: string,
    targetId: string,
    tenantId: string | null = null,
  ): Promise<ContentReference> {
    await ensureContentReferencesTable(this.db);
    const existing = (await this.get({
      sourceId,
      targetId,
    })) as ContentReference | null;
    if (existing) {
      return existing;
    }

    return (await this.create({
      sourceId,
      targetId,
      tenantId,
    })) as ContentReference;
  }

  async unlink(sourceId: string, targetId: string): Promise<void> {
    await ensureContentReferencesTable(this.db);
    const existing = (await this.get({
      sourceId,
      targetId,
    })) as ContentReference | null;
    if (existing) {
      await existing.delete();
    }
  }
}
