// The user app's runtime. Runs inside its own worker thread, so it has its own
// smrt registry: built fresh from one definition, thrown away on the next.
//
// Migrations here are SQLite-shaped (RENAME/DROP COLUMN, VACUUM INTO,
// pragma_table_xinfo). Postgres is future work.
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ObjectRegistry,
  planRuntimeModelDDL,
  registerRuntimeModel,
  withCallerOwnedDatabaseTransaction,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import type { RuntimeReportSpec } from '@happyvertical/smrt-reports';
import { getDatabase } from '@happyvertical/sql';
import {
  applyLoad,
  type LoadRecordsCommand,
  prepareLoad,
  undoRows,
} from './data-migrations.ts';
import {
  type AppDefinition,
  builtInFields,
  classNameFor,
  coerceValue,
  convertValue,
  describeApp,
  type FieldDef,
  type Migration,
  type ModelDef,
  RECIPES,
  recipeModelFor,
  restRouteAllowed,
  routeFor,
  type Step,
  snake,
  sqlType,
  storageFamily,
  tableFor,
  toolNamesFor,
  toRuntimeModel,
  USER_PKG,
  visible,
} from './definition.ts';
import { AppError } from './errors.ts';
import {
  applyExtract,
  type ExtractModelCommand,
  prepareExtract,
  undoExtract,
} from './extract-model.ts';
import {
  applyMerge,
  type MergeRecordsCommand,
  prepareMerge,
  undoMerge,
} from './merge-records.ts';
import { compileReport, type ReportOptions, runAppReport } from './reports.ts';
import {
  type MethodOutput,
  runMethod,
  SANDBOX_LIMITS,
  validateWrites,
  type Write,
} from './sandbox.ts';
import { pruneMethodSnapshots, pruneMigrationSnapshots } from './snapshots.ts';

type Row = Record<string, unknown>;
type Handle = any;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const OWNER = { id: 'owner', roles: ['admin'] };
const PROFILE_TYPES = '@happyvertical/smrt-profiles:ProfileType';

export interface BootResult {
  statements: string[];
  snapshot: string | null;
}

export class AppRuntime {
  readonly def: AppDefinition;
  readonly version: number;
  private db: Handle;
  private dataDir: string;
  private snapshots = 0;

  constructor(dataDir: string, def: AppDefinition, version: number) {
    this.dataDir = dataDir;
    this.def = def;
    this.version = version;
  }

  /**
   * Open app.db, register the definition, and bring the tables up to it: the
   * migration's steps (if any) and then the additive changes, all in one
   * transaction. A failure leaves app.db exactly as it was.
   */
  async boot(
    migration?: Migration,
    readOnly = false,
    validateOnly = false,
  ): Promise<BootResult> {
    if (validateOnly) {
      await this.register();
      for (const report of Object.values(this.def.reports ?? {}))
        await compileReport(this.def, report.spec);
      return { statements: [], snapshot: null };
    }
    mkdirSync(join(this.dataDir, 'snapshots'), { recursive: true });
    this.db = await getDatabase({
      type: 'sqlite',
      url: join(this.dataDir, 'app.db'),
    } as any);
    await this.register();
    for (const report of Object.values(this.def.reports ?? {}))
      await compileReport(this.def, report.spec);
    if (readOnly) return { statements: [], snapshot: null };
    const steps = migration?.steps ?? [];
    if (!steps.length) await this.checkColumns(this.db);
    // With steps the tables change first; planning happens inside the transaction.
    const needed =
      steps.length > 0 || (await this.plan(this.db, false)).length > 0;
    const statements: string[] = [];
    let snapshot: string | null = null;
    if (needed) {
      snapshot = await this.snapshot(
        steps.length
          ? `migrate-v${migration?.version}-${migration?.direction}`
          : 'schema',
      );
      await this.db.transaction(async (tx: Handle) =>
        withCallerOwnedDatabaseTransaction(tx, async () => {
          await tx.query(
            `CREATE TABLE IF NOT EXISTS _archive (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, tbl TEXT NOT NULL, col TEXT NOT NULL, record_id TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL)`,
          );
          if (
            steps.every(
              (s) =>
                s.op === 'loadRecords' ||
                s.op === 'extractModel' ||
                s.op === 'mergeRecords',
            )
          )
            statements.push(...(await this.plan(tx, true)));
          await tx.query(
            'CREATE INDEX IF NOT EXISTS _archive_lookup ON _archive (version, tbl, col, record_id)',
          );
          const ordered =
            migration?.direction === 'down' ? [...steps].reverse() : steps;
          for (const step of ordered)
            statements.push(
              ...(await this.runStep(tx, step, migration as Migration)),
            );
          await this.checkColumns(tx);
          statements.push(...(await this.plan(tx, true)));
        }),
      );
    }
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS _app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    for (const [k, v] of [
      ['version', String(this.version)],
      ['definition', JSON.stringify(this.def)],
    ])
      await this.db
        .execute`INSERT INTO _app_meta (key, value) VALUES (${k}, ${v}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    return { statements, snapshot };
  }

  // ---------- registry and tables ----------

  /** Register the definition's models in this (fresh) registry. */
  private async register() {
    if (this.def.recipes.length) await import('@happyvertical/smrt-profiles');
    for (const [model, md] of Object.entries(this.def.models)) {
      const rt = this;
      const methods: Record<
        string,
        (this: { id?: string }, p?: Row) => unknown
      > = {};
      for (const name of Object.keys(md.methods ?? {}))
        methods[name] = function (this: { id?: string }, params?: Row) {
          return rt.runMethod(model, name, this.id ?? null, params ?? {});
        };
      registerRuntimeModel(toRuntimeModel(model, md), {
        methods: methods as never,
      });
      // The app uses only its subclass: close the shipped parent's generated
      // surfaces so its tools do not duplicate the subclass's.
      const parent = recipeModelFor(model, md)?.parent;
      if (parent)
        ObjectRegistry.registerOverride(parent, { api: false, mcp: false });
    }
  }

  private qualified(model: string) {
    return `${USER_PKG}:${classNameFor(model, this.def.models[model])}`;
  }

  /**
   * Statements that bring tables up to the registered models, reading
   * through `h`. With `run`, each model's statements execute before the next
   * is planned (the subclass of a shipped model plans against its parent's
   * table). Shipped tables come first.
   */
  private async plan(h: Handle, run: boolean): Promise<string[]> {
    const qualifieds = [
      ...this.def.recipes.flatMap((r) => RECIPES[r]?.tables ?? []),
      ...Object.keys(this.def.models).map((m) => this.qualified(m)),
    ];
    // A subclass plans after the shipped parent it extends.
    const out: string[] = [];
    for (const qn of qualifieds) {
      const statements = await planRuntimeModelDDL(qn, 'sqlite', (t) =>
        this.existingColumns(h, t),
      );
      if (run) for (const s of statements) await h.query(s);
      out.push(...statements);
      if (!run && statements.length) break; // enough to know there is work
    }
    return out;
  }

  private async existingColumns(
    h: Handle,
    table: string,
  ): Promise<string[] | null> {
    const rows = (
      await h.query(`SELECT name FROM pragma_table_xinfo(?)`, [table])
    ).rows;
    return rows.length ? rows.map((r: Row) => String(r.name)) : null;
  }

  /** A column that exists with another storage family than its field wants: refuse. */
  private async checkColumns(h: Handle) {
    for (const [model, md] of Object.entries(this.def.models)) {
      const table = tableFor(model, md);
      const have = await this.columnTypes(h, table);
      if (!have.size) continue;
      for (const [f, fd] of Object.entries(visible(md.fields))) {
        const col = have.get(snake(f));
        if (col && storageFamily(col) !== storageFamily(sqlType(fd.type)))
          throw new AppError(
            `${table}.${snake(f)} already holds ${col} data; remove that field or change its type instead`,
          );
      }
    }
  }

  private async columnTypes(
    h: Handle,
    t: string,
  ): Promise<Map<string, string>> {
    const rows = (
      await h.query(`SELECT name, type FROM pragma_table_xinfo(?)`, [t])
    ).rows;
    return new Map(rows.map((r: Row) => [String(r.name), String(r.type)]));
  }

  private async tableExists(h: Handle, t: string) {
    return (
      (
        await h.query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          [t],
        )
      ).rows.length > 0
    );
  }

  // ---------- migration steps ----------

  /** Run one step up or down inside the boot transaction; returns what it did. */
  private async runStep(
    tx: Handle,
    step: Step,
    m: Migration,
  ): Promise<string[]> {
    const done: string[] = [];
    const exec = async (sql: string, params: unknown[] = []) => {
      await tx.query(sql, params);
      done.push(sql);
    };
    const now = new Date().toISOString();
    const up = m.direction === 'up';
    switch (step.op) {
      case 'mergeRecords':
        if (up) await applyMerge(this.def, tx, step.command, m.version);
        else await undoMerge(this.def, tx, step.command, m.version);
        done.push(`-- ${up ? 'merge' : 'undo merge'} records`);
        break;
      case 'extractModel':
        if (up)
          await applyExtract(
            this.def,
            tx,
            step.command,
            step.from,
            m.version,
            step.seed,
          );
        else await undoExtract(this.def, tx, step.command, m.version);
        done.push(`-- ${up ? 'extract' : 'undo extract'} model`);
        break;
      case 'loadRecords':
        if (up)
          await applyLoad(
            this.def,
            tx,
            step.command,
            m.version,
            step.seed,
            recipeModelFor(
              step.command.model,
              this.def.models[step.command.model],
            )
              ? { typeId: await this.personType(tx) }
              : {},
          );
        else await undoRows(this.def, tx, m.version);
        done.push(`-- ${up ? 'load' : 'undo load'} records`);
        break;
      case 'calculation': {
        if (up && step.from && !step.from.calculated)
          await exec(
            `INSERT INTO _archive (version, tbl, col, record_id, value, created_at) SELECT ?, ?, ?, id, ${q(step.column)}, ? FROM ${q(step.table)}`,
            [m.version, step.table, step.column, now],
          );
        if ((await this.columnTypes(tx, step.table)).has(step.column))
          await exec(
            `ALTER TABLE ${q(step.table)} DROP COLUMN ${q(step.column)}`,
          );
        if (!up && step.from && !step.from.calculated) {
          await exec(
            `ALTER TABLE ${q(step.table)} ADD COLUMN ${q(step.column)} ${sqlType(step.from.type)}`,
          );
          await exec(
            `UPDATE ${q(step.table)} SET ${q(step.column)} = (SELECT value FROM _archive a WHERE a.version = ? AND a.tbl = ? AND a.col = ? AND a.record_id = ${q(step.table)}.id)`,
            [m.version, step.table, step.column],
          );
          await exec(
            'DELETE FROM _archive WHERE version = ? AND tbl = ? AND col = ?',
            [m.version, step.table, step.column],
          );
        }
        break;
      }
      case 'renameColumn':
        await exec(
          `ALTER TABLE ${q(step.table)} RENAME COLUMN ${q(up ? step.from : step.to)} TO ${q(up ? step.to : step.from)}`,
        );
        break;
      case 'archiveTable':
        // Undoing a removal puts the archived table back. A model that was
        // defined again since leaves an EMPTY table of that name (undoing a
        // define keeps its table): drop it so the original, with its rows,
        // can return. A table with rows is never dropped; the rename then
        // fails and says so.
        if (
          !up &&
          (await this.tableExists(tx, step.table)) &&
          (await tx.query(`SELECT 1 FROM ${q(step.table)} LIMIT 1`)).rows
            .length === 0
        )
          await exec(`DROP TABLE ${q(step.table)}`);
        await exec(
          `ALTER TABLE ${q(up ? step.table : step.archivedAs)} RENAME TO ${q(up ? step.archivedAs : step.table)}`,
        );
        break;
      case 'dropColumn':
        if (up) {
          if (!(await this.columnTypes(tx, step.table)).has(step.column)) break;
          await exec(
            `INSERT INTO _archive (version, tbl, col, record_id, value, created_at) SELECT ?, ?, ?, ${q(step.key)}, ${q(step.column)}, ? FROM ${q(step.table)} WHERE ${q(step.column)} IS NOT NULL AND ${q(step.column)} <> ''`,
            [m.version, step.table, step.column, now],
          );
          await exec(
            `ALTER TABLE ${q(step.table)} DROP COLUMN ${q(step.column)}`,
          );
        } else {
          // Undoing an add keeps its column, so a field added again after the
          // removal is still there: put the archived values back into it.
          if (!(await this.columnTypes(tx, step.table)).has(step.column))
            await exec(
              `ALTER TABLE ${q(step.table)} ADD COLUMN ${q(step.column)} ${sqlType(step.type)}`,
            );
          await exec(
            `UPDATE ${q(step.table)} SET ${q(step.column)} = (SELECT value FROM _archive a WHERE a.version = ? AND a.tbl = ? AND a.col = ? AND a.record_id = ${q(step.table)}.${q(step.key)})`,
            [m.version, step.table, step.column],
          );
          await exec(
            `DELETE FROM _archive WHERE version = ? AND tbl = ? AND col = ?`,
            [m.version, step.table, step.column],
          );
        }
        break;
      case 'convertColumn': {
        const target = up ? step.to : step.from;
        const tmp = `${step.column}__new`;
        const rows = (
          await tx.query(
            `SELECT ${q(step.key)} AS k, ${q(step.column)} AS v FROM ${q(step.table)}`,
          )
        ).rows;
        const archived = new Map<string, unknown>();
        if (up) {
          await exec(
            `INSERT INTO _archive (version, tbl, col, record_id, value, created_at) SELECT ?, ?, ?, ${q(step.key)}, ${q(step.column)}, ? FROM ${q(step.table)} WHERE ${q(step.column)} IS NOT NULL`,
            [m.version, step.table, step.column, now],
          );
        } else {
          for (const r of (
            await tx.query(
              `SELECT record_id, value FROM _archive WHERE version = ? AND tbl = ? AND col = ?`,
              [m.version, step.table, step.column],
            )
          ).rows)
            archived.set(String(r.record_id), r.value);
        }
        await exec(
          `ALTER TABLE ${q(step.table)} ADD COLUMN ${q(tmp)} ${sqlType(target.type)}`,
        );
        for (const r of rows) {
          // Going back, a row's original value wins; rows made since are converted back.
          const value =
            !up && archived.has(String(r.k))
              ? archived.get(String(r.k))
              : convertValue(r.v, target).value;
          await tx.query(
            `UPDATE ${q(step.table)} SET ${q(tmp)} = ? WHERE ${q(step.key)} = ?`,
            [value, r.k],
          );
        }
        done.push(`-- converted ${rows.length} values to ${target.type}`);
        await exec(
          `ALTER TABLE ${q(step.table)} DROP COLUMN ${q(step.column)}`,
        );
        await exec(
          `ALTER TABLE ${q(step.table)} RENAME COLUMN ${q(tmp)} TO ${q(step.column)}`,
        );
        if (!up)
          await exec(
            `DELETE FROM _archive WHERE version = ? AND tbl = ? AND col = ?`,
            [m.version, step.table, step.column],
          );
        break;
      }
    }
    return done;
  }

  // ---------- previews and archives ----------

  /** What a type change would do to existing values, without changing anything. */
  async columnInfo(table: string, column: string) {
    const row = (
      await this.db.query(
        'SELECT type, hidden FROM pragma_table_xinfo(?) WHERE name = ?',
        [table, column],
      )
    ).rows[0];
    return row
      ? { type: String(row.type), generated: Number(row.hidden) > 1 }
      : null;
  }

  async previewMerge(cmd: MergeRecordsCommand) {
    return this.db.transaction(
      async (tx: Handle) => (await prepareMerge(this.def, tx, cmd)).preview,
    );
  }

  async previewExtract(cmd: ExtractModelCommand) {
    return this.db.transaction(
      async (tx: Handle) => (await prepareExtract(this.def, tx, cmd)).preview,
    );
  }

  async previewLoad(cmd: LoadRecordsCommand) {
    return this.db.transaction(
      async (tx: Handle) => (await prepareLoad(this.def, tx, cmd)).preview,
    );
  }

  async previewConversion(
    table: string,
    key: string,
    column: string,
    to: FieldDef,
  ) {
    const rows = (
      await this.db.query(
        `SELECT ${q(key)} AS k, ${q(column)} AS v FROM ${q(table)}`,
      )
    ).rows as Row[];
    const failing = rows.filter(
      (r) => r.v !== null && !convertValue(r.v, to).ok,
    );
    const withValue = rows.filter((r) => r.v !== null).length;
    return {
      rows: rows.length,
      withValue,
      convertible: withValue - failing.length,
      failing: failing.slice(0, 10).map((r) => ({ id: r.k, value: r.v })),
      failingCount: failing.length,
    };
  }

  /** How many non-empty values a column holds (for a removal preview). */
  async countValues(table: string, column: string) {
    if (!(await this.columnTypes(this.db, table)).has(column)) return 0;
    const r = await this.db.query(
      `SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${q(column)} IS NOT NULL AND ${q(column)} <> ''`,
    );
    return Number(r.rows[0].n);
  }

  async countRows(table: string) {
    if (!(await this.tableExists(this.db, table))) return 0;
    const r = await this.db.query(`SELECT COUNT(*) AS n FROM ${q(table)}`);
    return Number(r.rows[0].n);
  }

  /** How many archived values and tables the given versions hold. */
  async countArchives(versions: number[], tables: string[]) {
    let values = 0;
    if (await this.tableExists(this.db, '_archive'))
      for (const v of versions)
        values += Number(
          (
            await this.db.query(
              `SELECT COUNT(*) AS n FROM _archive WHERE version = ?`,
              [v],
            )
          ).rows[0].n,
        );
    return { values, tables: tables.length };
  }

  /**
   * How many rows undoing `version`'s `convertColumn` steps would overwrite:
   * rows whose current value is not what converting the archived original
   * gives (they were edited, or created over the original, since).
   */
  async countOverwrites(version: number, steps: Step[]) {
    const out: { table: string; column: string; replaced: number }[] = [];
    for (const step of steps) {
      if (
        step.op === 'loadRecords' ||
        step.op === 'extractModel' ||
        step.op === 'mergeRecords'
      ) {
        const count = await this.db.query(
          "SELECT COUNT(*) AS n FROM _archive WHERE version = ? AND col = '$row'",
          [version],
        );
        out.push({
          table: step.command.model,
          column: '*',
          replaced: Number(count.rows[0].n),
        });
        continue;
      }
      if (step.op === 'calculation') {
        const count = await this.db.query(
          'SELECT COUNT(*) AS n FROM _archive WHERE version = ? AND tbl = ? AND col = ?',
          [version, step.table, step.column],
        );
        out.push({
          table: step.table,
          column: step.column,
          replaced:
            step.to && !step.to.calculated
              ? await this.countValues(step.table, step.column)
              : Number(count.rows[0].n),
        });
        continue;
      }
      if (step.op !== 'convertColumn') continue;
      let replaced = 0;
      if (
        (await this.tableExists(this.db, '_archive')) &&
        (await this.columnTypes(this.db, step.table)).has(step.column)
      ) {
        const archived = (
          await this.db.query(
            `SELECT record_id, value FROM _archive WHERE version = ? AND tbl = ? AND col = ?`,
            [version, step.table, step.column],
          )
        ).rows as Row[];
        const current = new Map<string, unknown>(
          (
            (
              await this.db.query(
                `SELECT ${q(step.key)} AS k, ${q(step.column)} AS v FROM ${q(step.table)}`,
              )
            ).rows as Row[]
          ).map((r) => [String(r.k), r.v]),
        );
        for (const a of archived) {
          const id = String(a.record_id);
          if (!current.has(id)) continue; // deleted since: nothing to overwrite
          const was = convertValue(a.value, step.to).value;
          const now = current.get(id);
          if ((was ?? null) !== (now ?? null) && String(was) !== String(now))
            replaced++;
        }
      }
      out.push({ table: step.table, column: step.column, replaced });
    }
    return out;
  }

  /** Delete archived values and tables for the given versions. */
  async purgeArchives(versions: number[], tables: string[]) {
    if (!versions.length && !tables.length) return { values: 0, tables: 0 };
    let values = 0;
    await this.db.transaction(async (tx: Handle) => {
      if (await this.tableExists(tx, '_archive'))
        for (const v of versions)
          values +=
            (await tx.query(`DELETE FROM _archive WHERE version = ?`, [v]))
              .rowCount ?? 0;
      for (const t of tables)
        if (await this.tableExists(tx, t)) await tx.query(`DROP TABLE ${q(t)}`);
    });
    return { values, tables: tables.length };
  }

  /** A consistent copy of app.db in snapshots/, made with VACUUM INTO. */
  async snapshot(kind: string): Promise<string> {
    const safe = kind.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    const file = join(
      this.dataDir,
      'snapshots',
      `${Date.now()}-${this.snapshots++}-${safe}.db`,
    );
    await this.db.query(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    // Applied method writes can come in a stream: keep only the newest few.
    if (safe.startsWith('method-'))
      pruneMethodSnapshots(join(this.dataDir, 'snapshots'));
    return file;
  }

  /**
   * A consistent, standalone copy of app.db at `path` (VACUUM INTO: one
   * statement, so it sees a single committed state, and it needs no -wal or
   * -shm file next to it). Refuses a path that exists. The host calls it with
   * no change running and no call in flight.
   */
  async copyTo(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new AppError('copyTo needs an absolute path');
    if (existsSync(path)) throw new AppError(`${path} already exists`);
    await this.db.query(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return path;
  }

  /** Delete migrate/schema snapshots taken before `beforeMs` (clean up). */
  pruneSnapshots(beforeMs: number) {
    return pruneMigrationSnapshots(
      join(this.dataDir, 'snapshots'),
      Number(beforeMs),
    );
  }

  // ---------- SMRT's generated surfaces ----------

  private mcp() {
    return new MCPGenerator({ name: 'app', version: String(this.version) }, {
      db: this.db,
      user: OWNER,
    } as any);
  }

  private toolNames(): Set<string> {
    return new Set(
      Object.entries(this.def.models).flatMap(([m, md]) => toolNamesFor(m, md)),
    );
  }

  /** The app's own generated MCP tools: chore_list, chore_complete, ... */
  async tools() {
    const mine = this.toolNames();
    return (await this.mcp().generateTools()).filter((t) => mine.has(t.name));
  }

  async callTool(name: string, args: Row) {
    if (!this.toolNames().has(name)) throw new AppError(`unknown tool ${name}`);
    const r: any = await this.mcp().handleToolCall({
      method: 'tools/call',
      params: { name, arguments: args },
    } as any);
    return {
      content: r.content,
      isError: !!r.isError,
      structuredContent: r.structuredContent,
    };
  }

  /** SMRT's generated REST routes. */
  async rest(req: { method: string; url: string; body?: string }) {
    if (!restRouteAllowed(this.def, req.url))
      return {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found' }),
      };
    const api = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (r: Request) => r,
      } as any,
      { db: this.db },
    );
    for (const [m, md] of Object.entries(this.def.models))
      api.registerCollection(
        routeFor(m, md),
        (await ObjectRegistry.getCollection(this.qualified(m), {
          db: this.db,
        })) as any,
      );
    const url = req.url.startsWith('/')
      ? `http://app.local${req.url}`
      : req.url;
    const hasBody =
      req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD';
    const r = await api.generateHandler()(
      new Request(url, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: hasBody ? req.body : undefined,
      }),
    );
    return {
      status: r.status,
      contentType: r.headers.get('content-type') ?? 'application/json',
      body: await r.text(),
    };
  }

  // ---------- records ----------

  compileReport(spec: unknown) {
    return compileReport(this.def, spec);
  }
  runReport(input: string | RuntimeReportSpec, options: ReportOptions) {
    return runAppReport(this.def, this.db, input, options);
  }

  describe() {
    return describeApp(this.def, this.version);
  }

  private modelDef(model: string): ModelDef {
    if (!Object.hasOwn(this.def.models, model))
      throw new AppError(`no model ${model}`);
    return this.def.models[model];
  }

  /** Fields a record of `model` carries: built-in ones and visible own ones. */
  private fieldsOf(model: string): Record<string, FieldDef> {
    const md = this.modelDef(model);
    return { ...builtInFields(model, md), ...visible(md.fields) };
  }

  private async collection(model: string) {
    this.modelDef(model);
    return ObjectRegistry.getCollection(this.qualified(model), { db: this.db });
  }

  private plain(model: string, obj: any): Row {
    const out: Row = {
      id: obj.id,
      createdAt: toIso(obj.created_at ?? obj.createdAt),
    };
    for (const f of Object.keys(this.fieldsOf(model))) {
      const v = obj[f];
      out[f] = v instanceof Date ? v.toISOString() : (v ?? null);
    }
    return out;
  }

  async list(model: string, limit = 200): Promise<Row[]> {
    const rows = await (await this.collection(model)).list({
      limit,
      orderBy: 'created_at DESC',
    } as any);
    return rows.map((r) => this.plain(model, r));
  }

  async get(model: string, id: string): Promise<Row> {
    const obj = await (await this.collection(model)).get(id);
    if (!obj) throw new AppError(`no ${model} ${id}`);
    return this.plain(model, obj);
  }

  /** Check and convert `data` for a write. `refs: false` skips target lookups (imports). */
  private async coerce(
    model: string,
    data: Row,
    creating: boolean,
    refs = true,
  ) {
    const fields = this.fieldsOf(model);
    const out: Row = {};
    for (const [k, v] of Object.entries(data)) {
      if (!Object.hasOwn(fields, k))
        throw new AppError(
          `${model} has no field '${k}' (fields: ${Object.keys(fields).join(', ')})`,
        );
      const fd = fields[k];
      if (fd.calculated)
        throw new AppError(`${model}.${k} is read-only (calculated)`);
      const c = coerceValue(fd, v);
      if (!c.ok) throw new AppError(`${model}.${k} ${c.error}`);
      if (refs && fd.type === 'reference' && c.value !== null) {
        const target = fd.ref as string;
        if (!(await (await this.collection(target)).get(String(c.value))))
          throw new AppError(`${model}.${k}: no ${target} with id ${c.value}`);
      }
      out[k] = c.value;
    }
    if (creating)
      for (const [k, fd] of Object.entries(fields))
        if (
          !fd.calculated &&
          fd.required &&
          (data[k] === undefined || data[k] === null || data[k] === '')
        )
          throw new AppError(`${model}.${k} is required`);
    return out;
  }

  async create(
    model: string,
    data: Row,
    opts: { id?: string; refs?: boolean } = {},
  ): Promise<Row> {
    const base = await this.coerce(model, data, true, opts.refs !== false);
    if (recipeModelFor(model, this.def.models[model]))
      base.typeId = await this.personType();
    if (opts.id) base.id = opts.id;
    const obj = await (await this.collection(model)).create(base as never);
    return this.get(model, String(obj.id));
  }

  async update(model: string, id: string, data: Row): Promise<Row> {
    const base = await this.coerce(model, data, false);
    const obj: any = await (await this.collection(model)).get(id);
    if (!obj) throw new AppError(`no ${model} ${id}`);
    for (const [k, v] of Object.entries(base)) obj[k] = v;
    await obj.save();
    return this.get(model, id);
  }

  async remove(model: string, id: string) {
    const obj: any = await (await this.collection(model)).get(id);
    if (!obj) throw new AppError(`no ${model} ${id}`);
    await obj.delete();
    return { deleted: id };
  }

  /** Create records of a template with their ids (references stay valid). */
  async importRecords(records: Record<string, Row[]>) {
    let n = 0;
    for (const [model, rows] of Object.entries(records)) {
      this.modelDef(model);
      for (const row of rows) {
        const { id, createdAt: _c, ...data } = row;
        for (const [f, fd] of Object.entries(this.fieldsOf(model)))
          if (fd.calculated) delete data[f];
        await this.create(model, data, {
          id: typeof id === 'string' ? id : undefined,
          refs: false,
        });
        n++;
      }
    }
    return { records: n };
  }

  /** Find or create the real `person` ProfileType (the type of every app Profile). */
  private async personType(db: Handle = this.db): Promise<string> {
    const types: any = await ObjectRegistry.getCollection(PROFILE_TYPES, {
      db,
    });
    const found = (
      await types.list({ where: { slug: 'person' }, limit: 1 })
    )[0];
    if (found) return String(found.id);
    return String((await types.create({ name: 'Person', slug: 'person' })).id);
  }

  // ---------- methods ----------

  async runMethod(
    model: string,
    method: string,
    id: string | null,
    params: Row = {},
  ) {
    const md = this.modelDef(model).methods?.[method];
    if (!md) throw new AppError(`no method ${model}.${method}()`);
    for (const [p, pd] of Object.entries(md.params ?? {}))
      if (pd.required && params[p] == null)
        throw new AppError(`param ${p} is required`);
    const data: Record<string, Row[]> = {};
    for (const m of Object.keys(this.def.models))
      data[m] = await this.list(m, 1000);
    const record = id ? await this.get(model, id) : null;
    let out: MethodOutput;
    try {
      out = await runMethod(md.code, { record, params, data });
    } catch (e) {
      throw new AppError((e as Error).message);
    }
    let writes: Write[];
    try {
      writes = validateWrites(
        out.writes,
        Object.fromEntries(
          Object.keys(this.def.models).map((m) => [
            m,
            { fields: this.fieldsOf(m) },
          ]),
        ),
        SANDBOX_LIMITS.maxWrites,
      );
      await this.checkWrites(writes);
    } catch (e) {
      throw new AppError(
        `method ${model}.${method}() proposed bad writes, none applied: ${(e as Error).message}`,
      );
    }
    if (!writes.length)
      return { result: out.result, writes: [], applied: 0, snapshot: null };
    // Snapshot first: anything the writes do can be taken back from it.
    const snapshot = await this.snapshot(`method-${model}.${method}`);
    let applied = 0;
    try {
      for (const w of writes) {
        if (w.op === 'create') await this.create(w.model, w.data ?? {});
        else if (w.op === 'update')
          await this.update(w.model, String(w.id), w.data ?? {});
        else await this.remove(w.model, String(w.id));
        applied++;
      }
    } catch (e) {
      throw new AppError(
        `method ${model}.${method}() failed after ${applied} of ${writes.length} writes (snapshot: ${snapshot}): ${(e as Error).message}`,
      );
    }
    return { result: out.result, writes, applied, snapshot };
  }

  /** Reads only: records exist, required fields are present, references resolve. */
  private async checkWrites(writes: Write[]) {
    for (const w of writes) {
      if (w.op === 'create') await this.coerce(w.model, w.data ?? {}, true);
      else {
        if (!(await (await this.collection(w.model)).get(String(w.id))))
          throw new AppError(`no ${w.model} ${w.id}`);
        if (w.op === 'update') await this.coerce(w.model, w.data ?? {}, false);
      }
    }
  }
}

function toIso(v: unknown) {
  return v instanceof Date ? v.toISOString() : (v ?? null);
}

export type { MethodOutput };
