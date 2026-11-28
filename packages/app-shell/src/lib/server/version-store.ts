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
//
// Hosted app: a store is made for ONE tenant (`tenantId`) and every operation
// runs inside that tenant's context (`inTenant`), so the tenant-scoped models
// read and write only that tenant's rows whatever the caller's context is.
// `appRow()` is the tenant-to-app mapping: the tenant's `App` row, created on
// the tenant's first request.
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type AppDefinition,
  StaleStoreError,
  type VersionRecord,
  type VersionStore,
} from '../../engine/index.ts';
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
import { clearGrantsAcross, creationStamps } from './model-access.ts';
import { bindAmbientShellScope, isPostgresHandle } from './shell-tenancy.ts';

export const APP_SLUG = 'app';

const stampCache = new Map<
  string,
  { def: AppDefinition | null; stamps: Map<string, string> }
>();

type VersionRow = AppVersion | AppDraftVersion;

/** The rows of a raw query result (adapters return `{ rows }`). */
const rowsOf = (r: unknown): unknown[] =>
  ((r as { rows?: unknown[] })?.rows ?? []) as unknown[];

/**
 * Run `fn` inside the store's own tenant. A store belongs to ONE tenant in the
 * hosted app and never trusts the ambient context to be that tenant: it
 * refuses when a different tenant is ambient, and enters its own when none is
 * (the engine calls stores from its own queue, outside any request). With no
 * tenant (the desktop's single owner) it changes nothing.
 */
function inTenant<T>(
  tenantId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tenantId) return fn();
  const ambient = getCurrentTenant();
  if (ambient?.tenantId && ambient.tenantId !== tenantId)
    return Promise.reject(new Error('this store belongs to another tenant'));
  if (ambient?.tenantId === tenantId) return fn();
  return withTenant({ tenantId, permissions: new Set<string>() }, fn);
}

/**
 * The hosted claim's transaction is not one the shell's handle opened, so on
 * PostgreSQL the shell's rows inside it (forced row-level security) need the
 * ambient tenant published to it first. A no-op for a store with no tenant (the
 * desktop) and when the shell's own database is not PostgreSQL (SQLite tests).
 */
async function bindClaimTx(
  db: DatabaseInterface,
  tenantId: string | null,
  tx: unknown,
): Promise<void> {
  if (tenantId && isPostgresHandle(db)) await bindAmbientShellScope(tx);
}

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
  /** The `App` row's id, once read on the shell's own connection (`reachable` needs it inside a claim transaction). */
  private appId: string | null = null;

  constructor(
    private readonly db: DatabaseInterface,
    private readonly tenantId: string | null = null,
  ) {}

  private scoped<T>(fn: () => Promise<T>): Promise<T> {
    return inTenant(this.tenantId, fn);
  }

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
  appRow(db: DatabaseInterface = this.db): Promise<App> {
    return this.scoped(async () => {
      const apps = await this.apps(db);
      const rows = await apps.list({ where: { slug: APP_SLUG }, limit: 1 });
      if (rows[0]) {
        this.appId ??= rows[0].id as string;
        return rows[0];
      }
      const created = await apps.create({
        slug: APP_SLUG,
        name: 'My app',
        currentVersion: -1,
        definition: '',
      });
      await created.save();
      this.appId ??= created.id as string;
      return created;
    });
  }

  async current(): Promise<number | null> {
    const v = Number((await this.appRow()).currentVersion);
    return v < 0 ? null : v;
  }

  /**
   * The current definition and each model's creation stamp (#5197). Cached per
   * current version row (versions are immutable; the row id changes if a
   * number is ever re-used).
   */
  modelStamps(): Promise<{
    def: AppDefinition | null;
    stamps: Map<string, string>;
  }> {
    return this.scoped(async () => {
      const app = await this.appRow();
      const current = Number(app.currentVersion);
      const row = current < 0 ? null : await this.row(current);
      if (!row) return { def: null, stamps: new Map() };
      const key = `${this.tenantId ?? ''}:${current}:${row.id}`;
      let hit = stampCache.get(key);
      if (!hit) {
        const all = await this.list();
        hit = {
          def: JSON.parse(row.definition) as AppDefinition,
          stamps: creationStamps(all, current),
        };
        if (stampCache.size > 200) stampCache.clear();
        stampCache.set(key, hit);
      }
      return hit;
    });
  }

  private async point(
    version: number,
    db: DatabaseInterface,
    via: VersionRecord[] = [],
  ): Promise<void> {
    const rec = await this.row(version, db);
    if (!rec) throw new Error(`version ${version} is not stored`);
    const app = await this.appRow(db);
    // Staff grants of a model that leaves the definition go with it (#5197).
    await clearGrantsAcross(db, this.tenantId, app.definition, [
      ...via.map((r) => JSON.stringify(r.definition)),
      rec.definition,
    ]);
    app.currentVersion = version;
    app.definition = rec.definition;
    try {
      app.name = JSON.parse(rec.definition).name ?? app.name;
    } catch {
      /* keep the name */
    }
    await app.save();
  }

  setCurrent(version: number): Promise<void> {
    return this.scoped(() => this.point(version, this.db));
  }

  get(version: number): Promise<VersionRecord | null> {
    return this.scoped(async () => {
      const row = await this.row(version);
      return row ? toRecord(row) : null;
    });
  }

  list(): Promise<VersionRecord[]> {
    return this.scoped(async () => {
      const rows = await (await this.versions()).list({ limit: 100000 });
      return rows.map(toRecord).sort((a, b) => a.version - b.version);
    });
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

  append(record: VersionRecord): Promise<void> {
    return this.scoped(() => this.insert(record, this.db));
  }

  /**
   * Append `records` and point at `current` in ONE transaction. Any failure
   * (a version that already exists, a missing target, a write error) rolls all
   * of it back, so a publish that fails here leaves no orphan versions and the
   * pointer where it was. When a publish names its draft ({@link publishing}),
   * the draft's `published` mark is in the same transaction.
   */
  commit(records: VersionRecord[], current: number): Promise<void> {
    return this.scoped(() => this.commitScoped(records, current));
  }

  private async commitScoped(
    records: VersionRecord[],
    current: number,
  ): Promise<void> {
    const db = this.db;
    if (typeof db.transaction !== 'function')
      throw new Error('the shell database cannot run transactions');
    const mark = this.publishing;
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DatabaseInterface;
      for (const r of records) await this.insert(r, txDb);
      await this.point(current, txDb, records);
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

  /**
   * `commit` inside the hosted engine's claim transaction `tx`, which also
   * holds the schema swap (#5470). The pointer moves only if it is still
   * `expected` (a compare-and-set on the `App` row, whose lock lasts until the
   * transaction ends); otherwise nothing is written and the swap rolls back
   * with it. Only `tx` is used: no other connection may be touched inside it.
   */
  commitIn(
    tx: unknown,
    records: VersionRecord[],
    current: number,
    expected: number | null,
    markDraft = false,
  ): Promise<void> {
    return this.scoped(async () => {
      await bindClaimTx(this.db, this.tenantId, tx);
      const txDb = tx as DatabaseInterface;
      for (const r of records) await this.insert(r, txDb);
      const app = await this.appRow(txDb);
      const rec = await this.row(current, txDb);
      if (!rec) throw new Error(`version ${current} is not stored`);
      let name = app.name;
      try {
        name = JSON.parse(rec.definition).name ?? name;
      } catch {
        /* keep the name */
      }
      await clearGrantsAcross(txDb, this.tenantId, app.definition, [
        ...records.map((r) => JSON.stringify(r.definition)),
        rec.definition,
      ]);
      const hit = await txDb.query(
        `UPDATE apps SET current_version = ?, definition = ?, name = ? WHERE id = ? AND current_version = ?${this.tenantClause} RETURNING id`,
        [
          current,
          rec.definition,
          name,
          app.id,
          expected ?? -1,
          ...this.tenantParam,
        ],
      );
      if (!rowsOf(hit).length)
        throw new StaleStoreError(
          `the stored current version is no longer ${expected ?? 'empty'}; nothing was written. Reopen the app.`,
          { expected },
        );
      const mark = markDraft ? this.publishing : null;
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

  /**
   * Take back versions this caller has just appended (a receive whose import
   * then refused, #5193): delete exactly `versions` and point back at
   * `restore` (`null`: no version yet), in ONE transaction.
   */
  unstage(versions: number[], restore: number | null): Promise<void> {
    return this.scoped(async () => {
      const db = this.db;
      if (typeof db.transaction !== 'function')
        throw new Error('the shell database cannot run transactions');
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as DatabaseInterface;
        for (const v of versions)
          await txDb.query(
            `DELETE FROM app_versions WHERE version = ?${this.tenantClause}`,
            [v, ...this.tenantParam],
          );
        if (restore !== null) return this.point(restore, txDb);
        const app = await this.appRow(txDb);
        // No definition left: every staff grant goes with it, in this same
        // transaction, so a reused version number or model name never matches
        // a stale grant (#5197).
        await clearGrantsAcross(
          txDb,
          this.tenantId,
          app.definition,
          [''],
          true,
        );
        await txDb.query(
          `UPDATE apps SET current_version = -1, definition = '' WHERE id = ?${this.tenantClause}`,
          [app.id, ...this.tenantParam],
        );
      });
    });
  }

  reachable(tx: unknown): Promise<boolean> {
    return this.scoped(async () => {
      const id = this.appId ?? ((await this.appRow()).id as string);
      await bindClaimTx(this.db, this.tenantId, tx);
      const found = await (tx as DatabaseInterface).query(
        `SELECT id FROM apps WHERE id = ?${this.tenantClause}`,
        [id, ...this.tenantParam],
      );
      return rowsOf(found).length > 0;
    });
  }

  /** Raw SQL bypasses the tenancy interceptor: a hosted store names its tenant itself. */
  private get tenantClause() {
    return this.tenantId ? ' AND tenant_id = ?' : '';
  }
  private get tenantParam(): string[] {
    return this.tenantId ? [this.tenantId] : [];
  }

  publishingDraft(): string | null {
    return this.publishing?.draftId ?? null;
  }

  reopenDraftIn(
    tx: unknown,
    draftId: string,
    numbers: number[],
  ): Promise<boolean> {
    return this.scoped(async () => {
      const hit = await (tx as DatabaseInterface).query(
        `UPDATE app_drafts SET status = 'open', ended_at = '', published_versions = '' WHERE id = ? AND status = 'published' AND published_versions = ?${this.tenantClause} RETURNING id`,
        [draftId, JSON.stringify(numbers), ...this.tenantParam],
      );
      return rowsOf(hit).length > 0;
    });
  }

  markPurged(version: number): Promise<void> {
    return this.scoped(async () => markRowPurged(await this.row(version)));
  }

  markPurgedIn(tx: unknown, versions: number[]): Promise<void> {
    return this.scoped(async () => {
      await bindClaimTx(this.db, this.tenantId, tx);
      for (const v of versions)
        await markRowPurged(await this.row(v, tx as DatabaseInterface));
    });
  }

  maxVersion(): Promise<number> {
    return this.scoped(async () => {
      const rows = await (await this.versions()).list({ limit: 100000 });
      return rows.length ? Math.max(...rows.map((r) => Number(r.version))) : -1;
    });
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
    private readonly tenantId: string | null = null,
  ) {}

  private scoped<T>(fn: () => Promise<T>): Promise<T> {
    return inTenant(this.tenantId, fn);
  }

  private versions(db: DatabaseInterface = this.db) {
    return AppDraftVersionCollection.create({ db });
  }

  /** Raw SQL bypasses the tenancy interceptor: a hosted store names its tenant itself. */
  private get tenantClause() {
    return this.tenantId ? ' AND tenant_id = ?' : '';
  }
  private get tenantParam(): string[] {
    return this.tenantId ? [this.tenantId] : [];
  }

  private async draftRow() {
    const row = await (await AppDraftCollection.create({ db: this.db })).get(
      this.draftId,
    );
    if (!row) throw new Error('the draft is not stored');
    return row;
  }

  private async row(
    version: number,
    db: DatabaseInterface = this.db,
  ): Promise<AppDraftVersion | null> {
    const rows = await (await this.versions(db)).list({
      where: { draftId: this.draftId, version },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Append `records` and point the draft at `current` inside the hosted
   * engine's claim transaction `tx` (#5486), like `ShellVersionStore.commitIn`.
   * The pointer moves only if it is still `expected` AND the draft is still
   * being worked on (`starting` or `open`: a published or discarded draft takes
   * no writes); otherwise nothing is written. Only `tx` is used.
   */
  commitIn(
    tx: unknown,
    records: VersionRecord[],
    current: number,
    expected: number | null,
  ): Promise<void> {
    return this.scoped(async () => {
      await bindClaimTx(this.db, this.tenantId, tx);
      const txDb = tx as DatabaseInterface;
      for (const r of records) {
        if (await this.row(r.version, txDb))
          throw new Error(`version ${r.version} already exists`);
        const created = await (await this.versions(txDb)).create({
          draftId: this.draftId,
          ...columnsOf(r),
        });
        await created.save();
      }
      if (!(await this.row(current, txDb)))
        throw new Error(`version ${current} is not stored`);
      const hit = await txDb.query(
        `UPDATE app_drafts SET current_version = ? WHERE id = ? AND current_version = ? AND status IN ('starting', 'open')${this.tenantClause} RETURNING id`,
        [current, this.draftId, expected ?? -1, ...this.tenantParam],
      );
      if (!rowsOf(hit).length)
        throw new StaleStoreError(
          `the draft's stored current version is no longer ${expected ?? 'empty'}, or the draft has ended; nothing was written. Reopen the app.`,
          { expected },
        );
    });
  }

  current(): Promise<number | null> {
    return this.scoped(async () => {
      const v = Number((await this.draftRow()).currentVersion);
      return v < 0 ? null : v;
    });
  }

  setCurrent(version: number): Promise<void> {
    return this.scoped(async () => {
      if (!(await this.row(version)))
        throw new Error(`version ${version} is not stored`);
      const draft = await this.draftRow();
      draft.currentVersion = version;
      await draft.save();
    });
  }

  get(version: number): Promise<VersionRecord | null> {
    return this.scoped(async () => {
      const row = await this.row(version);
      return row ? toRecord(row) : null;
    });
  }

  list(): Promise<VersionRecord[]> {
    return this.scoped(async () => {
      const rows = await (await this.versions()).list({
        where: { draftId: this.draftId },
        limit: 100000,
      });
      return rows.map(toRecord).sort((a, b) => a.version - b.version);
    });
  }

  append(record: VersionRecord): Promise<void> {
    return this.scoped(async () => {
      if (await this.row(record.version))
        throw new Error(`version ${record.version} already exists`);
      const created = await (await this.versions()).create({
        draftId: this.draftId,
        ...columnsOf(record),
      });
      await created.save();
    });
  }

  markPurged(version: number): Promise<void> {
    return this.scoped(async () => markRowPurged(await this.row(version)));
  }

  markPurgedIn(tx: unknown, versions: number[]): Promise<void> {
    return this.scoped(async () => {
      await bindClaimTx(this.db, this.tenantId, tx);
      for (const v of versions)
        await markRowPurged(await this.row(v, tx as DatabaseInterface));
    });
  }

  async maxVersion(): Promise<number> {
    const rows = await this.list();
    return rows.length ? Math.max(...rows.map((r) => r.version)) : -1;
  }
}
