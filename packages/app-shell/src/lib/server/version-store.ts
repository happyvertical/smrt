// The engine's VersionStore on the shell's own models.
//
// Live: `AppVersion` rows (one per definition version, never deleted) and the
// singleton `App` row (the current pointer and a copy of the current
// definition). `commit` is the publish's atomic write: the new versions, the
// pointer and (when a publish names its draft) the draft's `published` mark
// land in ONE transaction, or none of them do.
//
// Draft: `AppDraftVersion` rows of one draft plus that draft's own pointer
// (`AppDraft.currentVersion`). Its first row is the live base the draft was
// copied from.

import type {
  VersionRecord,
  VersionStore,
} from '@happyvertical/smrt-app-engine';
import type { DatabaseInterface } from '@happyvertical/sql';
import { type App, AppCollection } from '../objects/App.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import {
  type AppDraftVersion,
  AppDraftVersionCollection,
} from '../objects/AppDraftVersion.ts';
import {
  type AppVersion,
  AppVersionCollection,
} from '../objects/AppVersion.ts';

export const APP_SLUG = 'app';

type VersionRow = AppVersion | AppDraftVersion;

function toRecord(row: VersionRow): VersionRecord {
  const migration = row.migration
    ? (JSON.parse(row.migration) as { steps: never[]; purged?: boolean })
    : null;
  if (migration && row.purged) migration.purged = true;
  return {
    version: Number(row.version),
    parent: Number(row.parent) < 0 ? null : Number(row.parent),
    author: row.author,
    summary: row.summary,
    definition: JSON.parse(row.definition),
    migration,
    // the ORM may hydrate a timestamp-looking column as a Date
    createdAt:
      (row.createdAt as unknown) instanceof Date
        ? (row.createdAt as unknown as Date).toISOString()
        : String(row.createdAt),
  };
}

/** The columns every version row shares, from an engine record. */
function columnsOf(record: VersionRecord) {
  return {
    version: record.version,
    parent: record.parent ?? -1,
    author: record.author,
    summary: record.summary,
    definition: JSON.stringify(record.definition),
    migration: record.migration ? JSON.stringify(record.migration) : '',
    createdAt: record.createdAt,
    purged: !!record.migration?.purged,
  };
}

/** Mark a row's migration purged (shared by both stores). */
async function markRowPurged(row: VersionRow | null): Promise<void> {
  if (!row) return;
  row.purged = true;
  if (row.migration) {
    row.migration = JSON.stringify({
      ...JSON.parse(row.migration),
      purged: true,
    });
  }
  await row.save();
}

/**
 * Set on the live store for the duration of one publish: the draft whose
 * `published` mark rides in `commit`'s transaction.
 */
export interface PublishMark {
  draftId: string;
}

export class ShellVersionStore implements VersionStore {
  /** The draft the next `commit` publishes (see {@link PublishMark}); drafts.ts sets and clears it. */
  publishing: PublishMark | null = null;

  constructor(private readonly db: DatabaseInterface) {}

  private versions(db: DatabaseInterface = this.db) {
    return AppVersionCollection.create({ db });
  }
  private apps(db: DatabaseInterface = this.db) {
    return AppCollection.create({ db });
  }

  private async row(
    version: number,
    db: DatabaseInterface = this.db,
  ): Promise<AppVersion | null> {
    const rows = await (await this.versions(db)).list({
      where: { version },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /** The singleton App row, created on first use. */
  async appRow(db: DatabaseInterface = this.db): Promise<App> {
    const apps = await this.apps(db);
    const rows = await apps.list({ where: { slug: APP_SLUG }, limit: 1 });
    if (rows[0]) return rows[0];
    const created = await apps.create({
      slug: APP_SLUG,
      name: 'My app',
      currentVersion: -1,
      definition: '',
    });
    await created.save();
    return created;
  }

  async current(): Promise<number | null> {
    const v = Number((await this.appRow()).currentVersion);
    return v < 0 ? null : v;
  }

  private async point(version: number, db: DatabaseInterface): Promise<void> {
    const rec = await this.row(version, db);
    if (!rec) throw new Error(`version ${version} is not stored`);
    const app = await this.appRow(db);
    app.currentVersion = version;
    app.definition = rec.definition;
    try {
      app.name = JSON.parse(rec.definition).name ?? app.name;
    } catch {
      /* keep the name */
    }
    await app.save();
  }

  async setCurrent(version: number): Promise<void> {
    await this.point(version, this.db);
  }

  async get(version: number): Promise<VersionRecord | null> {
    const row = await this.row(version);
    return row ? toRecord(row) : null;
  }

  async list(): Promise<VersionRecord[]> {
    const rows = await (await this.versions()).list({ limit: 100000 });
    return rows.map(toRecord).sort((a, b) => a.version - b.version);
  }

  private async insert(
    record: VersionRecord,
    db: DatabaseInterface,
  ): Promise<void> {
    if (await this.row(record.version, db))
      throw new Error(`version ${record.version} already exists`);
    const created = await (await this.versions(db)).create(columnsOf(record));
    await created.save();
  }

  async append(record: VersionRecord): Promise<void> {
    await this.insert(record, this.db);
  }

  /**
   * Append `records` and point at `current` in ONE transaction. Any failure
   * (a version that already exists, a missing target, a write error) rolls all
   * of it back, so a publish that fails here leaves no orphan versions and the
   * pointer where it was. When a publish names its draft ({@link publishing}),
   * the draft's `published` mark is in the same transaction.
   */
  async commit(records: VersionRecord[], current: number): Promise<void> {
    const db = this.db;
    if (typeof db.transaction !== 'function')
      throw new Error('the shell database cannot run transactions');
    const mark = this.publishing;
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DatabaseInterface;
      for (const r of records) await this.insert(r, txDb);
      await this.point(current, txDb);
      if (mark) {
        const draft = await (await AppDraftCollection.create({ db: txDb })).get(
          mark.draftId,
        );
        if (draft?.status !== 'open')
          throw new Error('the draft is no longer open');
        draft.status = 'published';
        draft.endedAt = new Date().toISOString();
        draft.publishedVersions = JSON.stringify(records.map((r) => r.version));
        await draft.save();
      }
    });
  }

  async markPurged(version: number): Promise<void> {
    await markRowPurged(await this.row(version));
  }

  async maxVersion(): Promise<number> {
    const rows = await (await this.versions()).list({ limit: 100000 });
    return rows.length ? Math.max(...rows.map((r) => Number(r.version))) : -1;
  }
}

/**
 * One draft's versions. The draft host only ever reads and appends; its own
 * pointer is the `AppDraft` row's `currentVersion`. The row must exist before
 * the host starts.
 */
export class DraftVersionStore implements VersionStore {
  constructor(
    private readonly db: DatabaseInterface,
    readonly draftId: string,
  ) {}

  private versions() {
    return AppDraftVersionCollection.create({ db: this.db });
  }

  private async draftRow() {
    const row = await (await AppDraftCollection.create({ db: this.db })).get(
      this.draftId,
    );
    if (!row) throw new Error('the draft is not stored');
    return row;
  }

  private async row(version: number): Promise<AppDraftVersion | null> {
    const rows = await (await this.versions()).list({
      where: { draftId: this.draftId, version },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async current(): Promise<number | null> {
    const v = Number((await this.draftRow()).currentVersion);
    return v < 0 ? null : v;
  }

  async setCurrent(version: number): Promise<void> {
    if (!(await this.row(version)))
      throw new Error(`version ${version} is not stored`);
    const draft = await this.draftRow();
    draft.currentVersion = version;
    await draft.save();
  }

  async get(version: number): Promise<VersionRecord | null> {
    const row = await this.row(version);
    return row ? toRecord(row) : null;
  }

  async list(): Promise<VersionRecord[]> {
    const rows = await (await this.versions()).list({
      where: { draftId: this.draftId },
      limit: 100000,
    });
    return rows.map(toRecord).sort((a, b) => a.version - b.version);
  }

  async append(record: VersionRecord): Promise<void> {
    if (await this.row(record.version))
      throw new Error(`version ${record.version} already exists`);
    const created = await (await this.versions()).create({
      draftId: this.draftId,
      ...columnsOf(record),
    });
    await created.save();
  }

  async markPurged(version: number): Promise<void> {
    await markRowPurged(await this.row(version));
  }

  async maxVersion(): Promise<number> {
    const rows = await this.list();
    return rows.length ? Math.max(...rows.map((r) => r.version)) : -1;
  }
}
