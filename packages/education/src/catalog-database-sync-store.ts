import type { DatabaseInterface } from '@happyvertical/sql';
import {
  CatalogResourceCollection,
  CatalogSyncStateCollection,
} from './catalog-collections.js';
import type {
  CatalogSourceRecord,
  CatalogSyncCheckpoint,
} from './catalog-contracts.js';
import type { CatalogSyncStore } from './catalog-sync-service.js';

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function checkpoint(row: {
  providerId: string;
  runId: string;
  cursor: string;
  complete: boolean;
  importedCount: number;
  failures: string;
  lastSuccessfulAt: string;
}): CatalogSyncCheckpoint {
  let failures: CatalogSyncCheckpoint['failures'] = [];
  try {
    const parsed: unknown = JSON.parse(row.failures);
    if (Array.isArray(parsed)) failures = parsed as typeof failures;
  } catch {
    // A corrupt historical failure ledger stays visible as an incomplete run.
    failures = [
      {
        code: 'invalid-failure-ledger',
        message: 'Stored failure ledger is invalid.',
      },
    ];
  }
  return {
    providerId: row.providerId,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.cursor ? { cursor: row.cursor } : {}),
    complete: row.complete,
    importedCount: row.importedCount,
    failures,
    ...(row.lastSuccessfulAt ? { lastSuccessfulAt: row.lastSuccessfulAt } : {}),
  };
}

/** Default durable store for metadata-only provider synchronization. */
export class CatalogDatabaseSyncStore implements CatalogSyncStore {
  constructor(private readonly db: DatabaseInterface) {}

  async getCheckpoint(
    providerId: string,
  ): Promise<CatalogSyncCheckpoint | undefined> {
    const states = await CatalogSyncStateCollection.create({ db: this.db });
    const rows = await states.list({ where: { providerId }, limit: 2 });
    if (rows.length > 1)
      throw new Error('Catalog provider has ambiguous sync state.');
    return rows[0] ? checkpoint(rows[0]) : undefined;
  }

  async saveCheckpoint(value: CatalogSyncCheckpoint): Promise<void> {
    const states = await CatalogSyncStateCollection.create({ db: this.db });
    const rows = await states.list({
      where: { providerId: value.providerId },
      limit: 2,
    });
    if (rows.length > 1)
      throw new Error('Catalog provider has ambiguous sync state.');
    const fields = {
      providerId: value.providerId,
      runId: value.runId ?? '',
      cursor: value.cursor ?? '',
      complete: value.complete,
      importedCount: value.importedCount,
      failures: json(value.failures),
      lastSuccessfulAt: value.lastSuccessfulAt ?? '',
    };
    if (rows[0]) {
      Object.assign(rows[0], fields);
      await rows[0].save();
    } else await states.create(fields);
  }

  async upsert(record: CatalogSourceRecord, runId: string): Promise<void> {
    const resources = await CatalogResourceCollection.create({ db: this.db });
    const rows = await resources.list({
      where: { providerId: record.providerId, stableId: record.stableId },
      limit: 2,
    });
    if (rows.length > 1)
      throw new Error('Catalog provider record identity is ambiguous.');
    const fields = {
      providerId: record.providerId,
      stableId: record.stableId,
      revision: record.revision,
      canonicalUrl: record.canonicalUrl,
      title: record.title,
      suppliedDescription: record.suppliedDescription ?? '',
      author: record.author ?? '',
      subjects: json(record.subjects ?? []),
      grades: json(record.gradeRange ?? {}),
      language: record.language ?? '',
      resourceType: record.resourceType ?? '',
      parentStableId: record.parentStableId ?? '',
      availableFormats: json(record.availableFormats ?? []),
      licenseEvidence: json(record.licenseEvidence),
      licenseState: record.licenseEvidence.state,
      visibility: record.visibility,
      lastSeenRunId: runId,
      withdrawnAt: '',
    };
    if (rows[0]) {
      Object.assign(rows[0], fields);
      await rows[0].save();
    } else await resources.create(fields);
  }

  async withdrawUnseen(providerId: string, runId: string): Promise<number> {
    const resources = await CatalogResourceCollection.create({ db: this.db });
    const rows = await resources.list({ where: { providerId } });
    const timestamp = new Date().toISOString();
    let withdrawn = 0;
    for (const row of rows) {
      if (row.lastSeenRunId === runId || row.withdrawnAt) continue;
      row.withdrawnAt = timestamp;
      await row.save();
      withdrawn++;
    }
    return withdrawn;
  }
}
