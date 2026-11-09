// The engine's VersionStore on the shell's own models: `AppVersion` rows (one
// per definition version, never deleted) and the singleton `App` row (the
// current pointer and a copy of the current definition).
import type { DatabaseInterface } from '@happyvertical/sql';
import type { VersionRecord, VersionStore } from '../../engine/index.ts';
import { type App, AppCollection } from '../models/App.ts';
import { type AppVersion, AppVersionCollection } from '../models/AppVersion.ts';

export const APP_SLUG = 'app';

function toRecord(row: AppVersion): VersionRecord {
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

export class ShellVersionStore implements VersionStore {
  constructor(private readonly db: DatabaseInterface) {}

  private versions() {
    return AppVersionCollection.create({ db: this.db });
  }
  private apps() {
    return AppCollection.create({ db: this.db });
  }

  private async row(version: number): Promise<AppVersion | null> {
    const rows = await (await this.versions()).list({
      where: { version },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /** The singleton App row, created on first use. */
  async appRow(): Promise<App> {
    const apps = await this.apps();
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

  async setCurrent(version: number): Promise<void> {
    const rec = await this.row(version);
    if (!rec) throw new Error(`version ${version} is not stored`);
    const app = await this.appRow();
    app.currentVersion = version;
    app.definition = rec.definition;
    try {
      app.name = JSON.parse(rec.definition).name ?? app.name;
    } catch {
      /* keep the name */
    }
    await app.save();
  }

  async get(version: number): Promise<VersionRecord | null> {
    const row = await this.row(version);
    return row ? toRecord(row) : null;
  }

  async list(): Promise<VersionRecord[]> {
    const rows = await (await this.versions()).list({ limit: 100000 });
    return rows.map(toRecord).sort((a, b) => a.version - b.version);
  }

  async append(record: VersionRecord): Promise<void> {
    if (await this.row(record.version))
      throw new Error(`version ${record.version} already exists`);
    const created = await (await this.versions()).create({
      version: record.version,
      parent: record.parent ?? -1,
      author: record.author,
      summary: record.summary,
      definition: JSON.stringify(record.definition),
      migration: record.migration ? JSON.stringify(record.migration) : '',
      createdAt: record.createdAt,
      purged: !!record.migration?.purged,
    });
    await created.save();
  }

  async markPurged(version: number): Promise<void> {
    const row = await this.row(version);
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

  async maxVersion(): Promise<number> {
    const rows = await (await this.versions()).list({ limit: 100000 });
    return rows.length ? Math.max(...rows.map((r) => Number(r.version))) : -1;
  }
}
