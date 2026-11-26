// Where definition versions are kept. The engine only talks to this
// interface; the shell implements it on its own models (App, AppVersion in
// shell.db). The engine itself touches only the data directory.
import type { AppDefinition, Step } from './definition.ts';

export interface VersionMigration {
  steps: Step[];
  /** Archived data was cleaned up: this change can no longer be undone. */
  purged?: boolean;
}

export interface VersionRecord {
  version: number;
  parent: number | null;
  author: string;
  summary: string;
  definition: AppDefinition;
  migration: VersionMigration | null;
  createdAt: string;
}

export interface VersionStore {
  /** The current version, or null for a store that has never held one. */
  current(): Promise<number | null>;
  setCurrent(version: number): Promise<void>;
  get(version: number): Promise<VersionRecord | null>;
  /** Every version, oldest first. */
  list(): Promise<VersionRecord[]>;
  append(record: VersionRecord): Promise<void>;
  /** Mark a version's migration `purged`. Never delete the record. */
  markPurged(version: number): Promise<void>;
  /** Highest version number held, or -1 when empty. */
  maxVersion(): Promise<number>;
  /**
   * Optional: append `records` and make `current` the current version as ONE
   * atomic change (all or nothing). A publish uses it when present; without it
   * the host appends one by one and a failure part-way leaves the appended
   * records behind as unreachable history (they are never current).
   */
  commit?(records: VersionRecord[], current: number): Promise<void>;
  /**
   * Optional, hosted PostgreSQL only (#5470): `commit`, but inside the caller's
   * transaction `tx` (the claim's), which also holds the schema swap. Refuses
   * with a `StaleStoreError` unless the stored current version is `expected`
   * (null: none yet), so the whole transaction rolls back. `markDraft` (a
   * publish only) also marks the draft this store is publishing.
   */
  commitIn?(
    tx: unknown,
    records: VersionRecord[],
    current: number,
    expected: number | null,
    markDraft?: boolean,
  ): Promise<void>;
  /**
   * Optional, with `commitIn` (#5630): `markPurged` for every version in
   * `versions`, inside the caller's claim transaction `tx`, so a host that
   * lost its claim marks nothing. Only `tx` is used.
   */
  markPurgedIn?(tx: unknown, versions: number[]): Promise<void>;
  /** Optional, with `commitIn`: can `tx` see this store's own app row? (False: the claim is on another database.) */
  reachable?(tx: unknown): Promise<boolean>;
  /** Optional, with `commitIn`: the draft the next publish marks `published`, for the journal. */
  publishingDraft?(): string | null;
  /**
   * Optional, with `commitIn`: put a draft a publish marked `published` back to
   * `open`, only while it still holds exactly these published `numbers`.
   * False when it does not (nothing changed).
   */
  reopenDraftIn?(
    tx: unknown,
    draftId: string,
    numbers: number[],
  ): Promise<boolean>;
}

export class MemoryVersionStore implements VersionStore {
  private cur: number | null = null;
  private records = new Map<number, VersionRecord>();

  async current() {
    return this.cur;
  }
  async setCurrent(version: number) {
    this.cur = version;
  }
  async get(version: number) {
    const r = this.records.get(version);
    return r ? structuredClone(r) : null;
  }
  async list() {
    return [...this.records.values()]
      .sort((a, b) => a.version - b.version)
      .map((r) => structuredClone(r));
  }
  async append(record: VersionRecord) {
    if (this.records.has(record.version))
      throw new Error(`version ${record.version} already exists`);
    this.records.set(record.version, structuredClone(record));
  }
  async markPurged(version: number) {
    const r = this.records.get(version);
    if (r?.migration) r.migration = { ...r.migration, purged: true };
  }
  async maxVersion() {
    return this.records.size ? Math.max(...this.records.keys()) : -1;
  }
  async commit(records: VersionRecord[], current: number) {
    for (const r of records)
      if (this.records.has(r.version))
        throw new Error(`version ${r.version} already exists`);
    for (const r of records) this.records.set(r.version, structuredClone(r));
    this.cur = current;
  }
}
