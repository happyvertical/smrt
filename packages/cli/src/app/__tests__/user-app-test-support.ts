/**
 * A small in-process FAKE of the app shell engine, typed by the slice the CLI
 * uses (`UserAppEngine`) plus the host the tests drive. The CLI has no package
 * edge to the shell (it would close a dependency cycle), and a test must never
 * import another package's build output, so the CLI suite supplies the engine
 * through the injected `userAppEngine` seam. The fake keeps its state in a
 * plain JSON file named `app.db` and never opens a SQLite database; the real
 * engine's round-trip fidelity is covered by the shell's own
 * `portable-export.test.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  UserAppEngine,
  UserAppSection,
  UserAppVersionRecord,
} from '../user-app-portability.js';

export interface TestHost {
  execute(
    command: Record<string, unknown>,
    options: { author?: string; approved?: boolean },
  ): Promise<unknown>;
  create(model: string, data: Record<string, unknown>): Promise<unknown>;
  list(model: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface TestStore {
  append(record: UserAppVersionRecord): Promise<void>;
  setCurrent(version: number): Promise<void>;
  current(): Promise<number | null>;
  list(): Promise<UserAppVersionRecord[]>;
}

export interface TestEngine extends UserAppEngine {
  AppHost: {
    open(dataDir: string, options: { store: TestStore }): Promise<TestHost>;
  };
  MemoryVersionStore: new () => TestStore;
  verifyUserApp(options: {
    dataDir: string;
    bundle: UserAppSection;
  }): Promise<{ ok: boolean }>;
}

type Row = Record<string, unknown>;
interface FakeTable {
  name: string;
  columns: string[];
  rows: Row[];
}
interface FakeModel {
  fields: Record<string, unknown>;
  hidden: string[];
}
interface FakeDefinition {
  models: Record<string, FakeModel>;
}
interface FakeState {
  definition: FakeDefinition;
  version: number;
  tables: FakeTable[];
  importedDigest?: string;
}

const ARCHIVE = '_archive';
const ARCHIVE_COLUMNS = ['model', 'field', 'row_id', 'value'];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sha = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

const digestVersions = (versions: UserAppVersionRecord[]) =>
  sha(
    versions.map((v) => ({
      version: v.version,
      parent: v.parent,
      author: v.author,
      summary: v.summary,
      definition: v.definition,
      migration: v.migration,
      createdAt: v.createdAt,
    })),
  );

const tableName = (model: string) => `data_${model.toLowerCase()}`;
const statePath = (dataDir: string) => join(dataDir, 'app.db');

function readState(dataDir: string): FakeState {
  return JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as FakeState;
}

function writeState(dataDir: string, state: FakeState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath(dataDir), JSON.stringify(state));
}

function freshState(): FakeState {
  return {
    definition: { models: {} },
    version: 1,
    tables: [{ name: ARCHIVE, columns: ARCHIVE_COLUMNS, rows: [] }],
  };
}

function sectionDigest(section: Omit<UserAppSection, 'digest'>): string {
  return sha({
    format: section.format,
    definition: section.definition,
    version: section.version,
    versionsDigest: section.versionsDigest,
    tables: section.tables.map((t) => t.digest),
  });
}

const tableDigest = (t: { name: string; columns: string[]; rows: Row[] }) =>
  sha({ name: t.name, columns: t.columns, rows: t.rows });

function buildSection(
  state: FakeState,
  versions: UserAppVersionRecord[],
): UserAppSection {
  const tables = [...state.tables]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((t) => ({ ...t, digest: tableDigest(t) }));
  const body = {
    format: 1,
    definition: state.definition,
    version: state.version,
    versions,
    versionsDigest: digestVersions(versions),
    tables,
  };
  return { ...body, digest: sectionDigest(body) };
}

class FakeStore implements TestStore {
  private records: UserAppVersionRecord[] = [];
  private head: number | null = null;
  async append(record: UserAppVersionRecord) {
    this.records.push(structuredClone(record));
  }
  async setCurrent(version: number) {
    this.head = version;
  }
  async current() {
    return this.head;
  }
  async list() {
    return structuredClone(this.records);
  }
}

class FakeHost implements TestHost {
  constructor(
    private readonly dataDir: string,
    private readonly store: TestStore,
    private readonly state: FakeState,
  ) {}

  private table(name: string): FakeTable {
    const found = this.state.tables.find((t) => t.name === name);
    if (!found) throw new Error(`No table ${name}`);
    return found;
  }

  private async record(
    summary: string,
    author: string,
    migration: UserAppVersionRecord['migration'],
  ) {
    const versions = await this.store.list();
    const parent = this.state.version;
    const next = Math.max(0, ...versions.map((v) => v.version)) + 1;
    await this.store.append({
      version: next,
      parent,
      author,
      summary,
      definition: structuredClone(this.state.definition),
      migration,
      createdAt: new Date().toISOString(),
    });
    await this.store.setCurrent(next);
    this.state.version = next;
    writeState(this.dataDir, this.state);
    return next;
  }

  async execute(
    command: Record<string, unknown>,
    options: { author?: string; approved?: boolean },
  ) {
    const author = options.author ?? 'test';
    const model = String(command.model ?? command.name ?? '');
    switch (command.type) {
      case 'defineModel': {
        const fields = (command.fields ?? {}) as Record<string, unknown>;
        this.state.definition.models[model] = { fields, hidden: [] };
        this.state.tables.push({
          name: tableName(model),
          columns: ['id', ...Object.keys(fields), 'created_at', 'updated_at'],
          rows: [],
        });
        return this.record(`define ${model}`, author, null);
      }
      case 'hideField': {
        this.state.definition.models[model].hidden.push(String(command.field));
        return this.record(`hide ${command.field}`, author, null);
      }
      case 'removeField': {
        if (!options.approved) throw new Error('removeField needs approval');
        const field = String(command.field);
        const table = this.table(tableName(model));
        const archive = this.table(ARCHIVE);
        for (const row of table.rows) {
          archive.rows.push({
            model,
            field,
            row_id: row.id,
            value: row[field],
          });
          delete row[field];
        }
        table.columns = table.columns.filter((c) => c !== field);
        delete this.state.definition.models[model].fields[field];
        return this.record(`remove ${field}`, author, {
          steps: [{ type: 'removeField', model, field }],
        });
      }
      case 'undo': {
        const versions = await this.store.list();
        const current = versions.find((v) => v.version === this.state.version);
        if (!current || current.parent === null) throw new Error('No undo');
        for (const step of (current.migration?.steps ?? []) as Array<{
          type: string;
          model: string;
          field: string;
        }>) {
          if (step.type !== 'removeField') continue;
          const table = this.table(tableName(step.model));
          const archive = this.table(ARCHIVE);
          const kept: Row[] = [];
          for (const entry of archive.rows) {
            if (entry.model !== step.model || entry.field !== step.field) {
              kept.push(entry);
              continue;
            }
            const row = table.rows.find((r) => r.id === entry.row_id);
            if (row) row[step.field] = entry.value;
          }
          archive.rows = kept;
          table.columns.splice(table.columns.length - 2, 0, step.field);
        }
        const parent = versions.find((v) => v.version === current.parent);
        this.state.definition = structuredClone(
          parent?.definition as FakeDefinition,
        );
        this.state.version = current.parent;
        await this.store.setCurrent(current.parent);
        writeState(this.dataDir, this.state);
        return current.parent;
      }
      default:
        throw new Error(`Unsupported command ${String(command.type)}`);
    }
  }

  async create(model: string, data: Record<string, unknown>) {
    const table = this.table(tableName(model));
    const now = new Date().toISOString();
    const row = {
      id: `${model}-${table.rows.length + 1}`,
      ...data,
      created_at: now,
      updated_at: now,
    };
    table.rows.push(row);
    writeState(this.dataDir, this.state);
    return row;
  }

  async list(model: string) {
    return structuredClone(this.table(tableName(model)).rows);
  }

  async close() {
    writeState(this.dataDir, this.state);
  }
}

const fakeEngine: TestEngine = {
  AppHost: {
    async open(dataDir, { store }) {
      const state = existsSync(statePath(dataDir))
        ? readState(dataDir)
        : freshState();
      if ((await store.list()).length === 0) {
        await store.append({
          version: 1,
          parent: null,
          author: 'system',
          summary: 'initial',
          definition: structuredClone(state.definition),
          migration: null,
          createdAt: new Date().toISOString(),
        });
        await store.setCurrent(1);
      }
      writeState(dataDir, state);
      return new FakeHost(dataDir, store, state);
    },
  },
  MemoryVersionStore: FakeStore,
  digestVersionHistory: digestVersions,
  checkUserAppBundle(bundle) {
    const problems: string[] = [];
    for (const table of bundle.tables) {
      if (table.digest !== tableDigest(table as FakeTable))
        problems.push(`table ${table.name} does not match its digest`);
    }
    if (bundle.digest !== sectionDigest(bundle))
      problems.push('the section does not match its digest');
    return problems;
  },
  async exportUserApp({ dataDir, versions }) {
    return buildSection(readState(dataDir), versions);
  },
  async importUserApp({ dataDir, bundle }) {
    if (existsSync(statePath(dataDir))) {
      if (readState(dataDir).importedDigest === bundle.digest)
        return summary('already-imported', bundle);
      throw new Error('A different user app is already installed.');
    }
    writeState(dataDir, {
      definition: bundle.definition as FakeDefinition,
      version: bundle.version,
      tables: bundle.tables.map(({ digest: _digest, ...t }) => t as FakeTable),
      importedDigest: bundle.digest,
    });
    return summary('imported', bundle);
  },
  async inspectUserApp({ dataDir }) {
    const state = readState(dataDir); // throws on anything but this fake's file
    return { integrity: true, recorded: Boolean(state.definition) };
  },
  async verifyUserApp({ dataDir, bundle }) {
    const rebuilt = buildSection(readState(dataDir), bundle.versions);
    return { ok: rebuilt.digest === bundle.digest };
  },
};

function summary(status: 'imported' | 'already-imported', b: UserAppSection) {
  return {
    status,
    tables: b.tables.length,
    rows: b.tables.reduce((n, t) => n + t.rows.length, 0),
    digest: b.digest,
  } as const;
}

/** The fake engine, for the injected `userAppEngine` seam. */
export async function loadTestEngine(): Promise<TestEngine> {
  return fakeEngine;
}

/** Start a copy of a bundled user app on its own history. */
export async function openCopy(
  engine: TestEngine,
  dataDir: string,
  section: UserAppSection,
): Promise<TestHost> {
  const store = new engine.MemoryVersionStore();
  for (const v of section.versions) await store.append(v);
  await store.setCurrent(section.version);
  return engine.AppHost.open(dataDir, { store });
}
