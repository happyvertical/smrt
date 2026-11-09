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
}
