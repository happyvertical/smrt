/** PostgreSQL release upgrade rehearsal. Uses each release's own built migrator. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareReleases } from '../../packages/core/dist/migrations.js';
import {
  getSystemTableShapes,
  SYSTEM_TABLE_NAMES,
} from '../../packages/core/dist/index.js';
const bookkeepingTables = new Set(SYSTEM_TABLE_NAMES);

export const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const stableJSON = (value) =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}
export function deterministicUuid(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function loadBuild(root, { manifests = true } = {}) {
  const core = await import(
    pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href
  );
  const migrations = await import(
    pathToFileURL(path.join(root, 'packages/core/dist/migrations.js')).href
  );
  if (manifests) {
    core.ObjectRegistry.clear();
    const packages = path.join(root, 'packages');
    // Seed every manifest before schema resolution, so cross-package ancestors
    // are available regardless of directory order. Core goes first, as in CLI discovery.
    const names = readdirSync(packages).sort((a, b) =>
      a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b),
    );
    let count = 0;
    for (const name of names) {
      const file = path.join(packages, name, 'dist/manifest.json');
      if (!existsSync(file)) continue;
      const manifest = readJSON(file);
      const result = core.ObjectRegistry.registerPackageManifest(manifest);
      if (!result.loaded) throw new Error(`Could not load manifest ${file}`);
      count++;
    }
    if (!count)
      throw new Error(`No built manifests in ${root}. Run pnpm build first.`);
  }
  return {
    ...core,
    ...migrations,
    release: readJSON(path.join(root, 'packages/core/package.json')).version,
  };
}

/** Use the CLI's existing devDependency, never a new dependency of core. */
export async function createDatabase(root) {
  const harnessRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const require = createRequire(
    path.join(harnessRoot, 'packages/cli/package.json'),
  );
  const { PGlite } = require('@electric-sql/pglite');
  const sqlPackage = findPackageJSON(
    '@happyvertical/sql',
    pathToFileURL(path.join(harnessRoot, 'packages/cli/package.json')).href,
  );
  const sqlEntry = readJSON(sqlPackage).exports['.'].import;
  const { getDatabase } = await import(
    pathToFileURL(path.resolve(path.dirname(sqlPackage), sqlEntry)).href
  );
  const client = new PGlite();
  const adapter = await getDatabase({ type: 'pglite', client });
  // PGlite executes PostgreSQL SQL. Give nested handles the same engine identity.
  const view = (db) => ({
    ...db,
    url: 'postgresql://release-gate/in-process',
    transaction: (work) => db.transaction((tx) => work(view(tx))),
    close: () => client.close(),
  });
  return view(adapter);
}

/** Introspect physical catalogs, never regenerate the old schema from new models. */
export async function introspect(
  db,
  release,
  { normalize = true, modelTables } = {},
) {
  const tables = {};
  const list = (
    await db.query(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
    )
  ).rows;
  for (const { name } of list) {
    const columns = (
      await db.query(
        `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS "notNull", pg_get_expr(d.adbin,d.adrelid) AS "default", a.attidentity AS identity, a.attgenerated AS generated
      FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND t.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`,
        [name],
      )
    ).rows;
    const constraints = (
      await db.query(
        `SELECT c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS definition,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY AS k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      rt.relname AS "referencesTable",
      ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY AS k(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS "referencesColumns"
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_class rt ON rt.oid=c.confrelid
      WHERE n.nspname='public' AND t.relname=$1 AND c.contype IN ('p','u','f','c') ORDER BY c.conname`,
        [name],
      )
    ).rows;
    const indexes = (
      await db.query(
        `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS definition
      FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname=$1 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.oid) ORDER BY i.relname`,
        [name],
      )
    ).rows;
    const table = {
      columns: Object.fromEntries(
        columns.map(({ name: col, ...value }) => [col, value]),
      ),
      primaryKey: constraints.find((c) => c.type === 'p')?.columns ?? [],
      constraints,
      indexes,
    };
    if (name.startsWith('_smrt_')) {
      table.rows = (await db.query(`SELECT * FROM ${quote(name)}`)).rows
        .map((row) => {
          const next = { ...row };
          if (normalize) {
            for (const [col, meta] of Object.entries(table.columns)) {
              if (next[col] === null || next[col] === undefined) continue;
              if (col === 'applied_by') next[col] = 'release-upgrade-gate';
              if (/timestamp|^date$/.test(meta.type))
                next[col] = '2000-01-01T00:00:00.000Z';
              if (/^(execution_time_ms|execution_time|duration_ms)$/.test(col))
                next[col] = 0;
            }
          }
          return next;
        })
        .sort((a, b) => stableJSON(a).localeCompare(stableJSON(b)));
    }
    tables[name] = table;
  }
  if (normalize) {
    const ids = new Map();
    for (const [name, table] of Object.entries(tables))
      for (const row of table.rows ?? []) {
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(row.id))) {
          ids.set(
            row.id,
            deterministicUuid(
              `${name}:${stableJSON({ ...row, id: undefined })}`,
            ),
          );
        }
      }
    for (const table of Object.values(tables)) {
      for (const row of table.rows ?? [])
        for (const col of Object.keys(row))
          if (ids.has(row[col])) row[col] = ids.get(row[col]);
      table.rows?.sort((a, b) => stableJSON(a).localeCompare(stableJSON(b)));
    }
  }
  return {
    format: 1,
    release,
    engine: 'postgres',
    capturedFrom: 'migrateSmrtSchemas on an empty database',
    tables,
    ...(modelTables ? { modelTables: [...modelTables].sort() } : {}),
  };
}

export async function capture({
  root,
  build,
  createDb = () => createDatabase(root),
}) {
  build ??= await loadBuild(root);
  const db = await createDb();
  try {
    const result = await build.migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/release-gate',
      engineHint: 'postgres',
      name: 'release_gate_capture',
      version: build.release,
      postgresSafe: false,
      useConcurrentIndexes: false,
    });
    if (result.refused || result.hasManualDrift)
      throw new Error(`Capture refused: ${describeStops(result).join('\n')}`);
    return await introspect(db, build.release, {
      modelTables: Object.keys(
        build.ObjectRegistry.getAllSchemasAsDefinitions(),
      ),
    });
  } finally {
    await db.close();
  }
}

export async function restore(
  snapshot,
  { root, createDb = () => createDatabase(root) } = {},
) {
  if (
    snapshot.format !== 1 ||
    snapshot.engine !== 'postgres' ||
    !snapshot.tables
  )
    throw new Error('Unsupported release snapshot');
  const db = await createDb();
  try {
    await db.transaction(async (db) => {
      for (const [name, table] of Object.entries(snapshot.tables)) {
        const columns = Object.entries(table.columns).map(([col, meta]) => {
          let sql = `${quote(col)} ${meta.type}`;
          if (meta.generated)
            sql += ` GENERATED ALWAYS AS (${meta.default}) STORED`;
          else if (meta.identity)
            sql += ` GENERATED ${meta.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
          else if (meta.default !== null && meta.default !== undefined)
            sql += ` DEFAULT ${meta.default}`;
          if (meta.notNull) sql += ' NOT NULL';
          return sql;
        });
        await db.query(`CREATE TABLE ${quote(name)} (${columns.join(', ')})`);
      }
      for (const [name, table] of Object.entries(snapshot.tables)) {
        for (const row of table.rows ?? [])
          await insertRow(db, name, row, table);
      }
      // Primary/unique/check first, foreign keys last. This supports mutual cycles.
      for (const foreign of [false, true]) {
        for (const [name, table] of Object.entries(snapshot.tables)) {
          for (const constraint of table.constraints ?? []) {
            if ((constraint.type === 'f') !== foreign) continue;
            await db.query(
              `ALTER TABLE ${quote(name)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`,
            );
          }
        }
      }
      for (const table of Object.values(snapshot.tables))
        for (const index of table.indexes ?? [])
          await db.query(index.definition);
    });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
async function insertRow(db, tableName, row, table, returning = false) {
  const columns = Object.keys(row).filter(
    (col) => !table.columns[col]?.generated,
  );
  if (!columns.length)
    return db.query(
      `INSERT INTO ${quote(tableName)} DEFAULT VALUES${returning ? ' RETURNING *' : ''}`,
    );
  return db.query(
    `INSERT INTO ${quote(tableName)} (${columns.map(quote).join(',')}) OVERRIDING SYSTEM VALUE VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})${returning ? ' RETURNING *' : ''}`,
    columns.map((col) => {
      const value = row[col];
      return /^(json|jsonb)$/.test(table.columns[col].type) &&
        value !== null &&
        typeof value !== 'string'
        ? JSON.stringify(value)
        : value;
    }),
  );
}

function valueFor(type, key) {
  if (type.endsWith('[]')) return '{}';
  if (type === 'uuid') return deterministicUuid(key);
  if (/int|numeric|decimal|real|double|float/.test(type)) return 1;
  if (type === 'boolean') return false;
  if (/timestamp/.test(type)) return '2000-01-01T00:00:00.000Z';
  if (type === 'date') return '2000-01-01';
  if (/^time/.test(type)) return '00:00:00';
  if (/^jsonb?$/.test(type)) return '{}';
  if (type === 'bytea') return new Uint8Array([1]);
  return `gate-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}
function firstCheckLiteral(table, col) {
  for (const constraint of table.constraints ?? []) {
    if (constraint.type !== 'c') continue;
    // Catalog output uses = ANY (ARRAY['first'::text,...]) for IN lists.
    const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(
      `(?:"${escaped}"|\\b${escaped}\\b)\\s*(?:=\\s*ANY\\s*\\(\\s*ARRAY\\[|IN\\s*\\()\\s*('(?:''|[^'])*'|[-+]?\\d+(?:\\.\\d+)?|true|false)`,
      'i',
    ).exec(constraint.definition);
    if (match) {
      const literal = match[1];
      return literal.startsWith("'")
        ? literal.slice(1, -1).replaceAll("''", "'")
        : /true|false/i.test(literal)
          ? literal.toLowerCase() === 'true'
          : Number(literal);
    }
  }
}
const emptySeedPlan = () => ({ suppliedRows: [], emptyByDesign: [] });
const seedFileName = (release) => `seed/${release}.json`;
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The checked-in escape for tables the generic seeder cannot fill (rule 6 wants
 * rows in every rehearsal database). `suppliedRows`: a real minimal row for a
 * table the generic row cannot satisfy. `emptyByDesign`: a table that must stay
 * empty. Each entry has a reason. A stale entry is a failure (see `seed`).
 */
export function validateSeedPlan(plan = emptySeedPlan(), label = 'seed plan') {
  if (!isRecord(plan))
    throw new Error(`${label} must be an object with suppliedRows and emptyByDesign`);
  const { suppliedRows = [], emptyByDesign = [], ...unknown } = plan;
  if (Object.keys(unknown).length)
    throw new Error(`${label} has unknown key(s): ${Object.keys(unknown).join(', ')}`);
  if (!Array.isArray(suppliedRows) || !Array.isArray(emptyByDesign))
    throw new Error(`${label}: suppliedRows and emptyByDesign must be arrays`);
  const seen = new Set();
  const named = (entry, kind) => {
    if (
      !isRecord(entry) ||
      !(typeof entry.table === 'string' && entry.table.trim()) ||
      !(typeof entry.reason === 'string' && entry.reason.trim())
    )
      throw new Error(`${label}: each ${kind} entry needs a table and a non-empty reason`);
    if (seen.has(entry.table))
      throw new Error(`${label}: table ${entry.table} is listed twice`);
    seen.add(entry.table);
  };
  for (const entry of suppliedRows) {
    named(entry, 'suppliedRows');
    if (!isRecord(entry.row) || !Object.keys(entry.row).length)
      throw new Error(`${label}: the row for ${entry.table} must be a non-empty object of column values`);
  }
  for (const entry of emptyByDesign) named(entry, 'emptyByDesign');
  return { suppliedRows, emptyByDesign };
}

/** The seed plan checked in for one snapshot; absent means both lists are empty. */
export function readSeedPlan(directory, release) {
  const file = path.join(directory, seedFileName(release));
  return existsSync(file)
    ? validateSeedPlan(readJSON(file), seedFileName(release))
    : emptySeedPlan();
}

/** A seed file whose snapshot is gone is stale; so is one with no release name. */
export function validateSeedFiles(directory, versions) {
  const folder = path.join(directory, 'seed');
  if (!existsSync(folder)) return;
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.json'))) {
    if (!versions.includes(name.slice(0, -5)))
      throw new Error(
        `Stale seed file seed/${name}: there is no snapshot for ${name.slice(0, -5)}. Delete it.`,
      );
  }
}

/**
 * Put one row in every model table of the snapshot (rule 6: a rehearsal on empty
 * tables proves nothing). Returns `seedFailures`, one line per problem, each
 * naming the table and the database error. Nothing here is a warning: a table
 * that did not get a row, a seeded reference that could not be aligned or that
 * points at no row, and a stale plan entry all fail the gate.
 */
export async function seed(db, snapshot, plan = emptySeedPlan()) {
  const { suppliedRows, emptyByDesign } = validateSeedPlan(plan);
  const supplied = new Map(suppliedRows.map((entry) => [entry.table, entry]));
  const empty = new Map(emptyByDesign.map((entry) => [entry.table, entry]));
  const rows = {};
  const models = snapshot.modelTables ? new Set(snapshot.modelTables) : null;
  const values = new Map();
  for (const [name, table] of Object.entries(snapshot.tables)) {
    if (models ? !models.has(name) : bookkeepingTables.has(name)) continue;
    const row = {};
    for (const [col, meta] of Object.entries(table.columns)) {
      if (meta.generated) continue;
      const value =
        firstCheckLiteral(table, col) ?? valueFor(meta.type, `${name}.${col}`);
      values.set(`${name}.${col}`, value);
      if (
        (meta.notNull && meta.default == null && !meta.identity) ||
        table.primaryKey?.includes(col)
      )
        row[col] = value;
    }
    rows[name] = row;
  }
  // Union FK endpoints so every component, including cycles, shares values.
  const parent = new Map();
  const find = (key) => {
    let next = key;
    const seen = new Set();
    while (parent.has(next) && !seen.has(next)) {
      seen.add(next);
      next = parent.get(next);
    }
    return next;
  };
  for (const [name, table] of Object.entries(snapshot.tables))
    for (const fk of table.constraints ?? []) {
      if (fk.type !== 'f') continue;
      fk.columns.forEach((col, i) => {
        const left = find(`${name}.${col}`);
        const right = find(`${fk.referencesTable}.${fk.referencesColumns[i]}`);
        if (left !== right) parent.set(left, right);
      });
    }
  for (const [name, row] of Object.entries(rows))
    for (const col of Object.keys(row))
      row[col] = values.get(find(`${name}.${col}`)) ?? row[col];
  const seedFailures = [];
  let seededTables = 0;
  const insertedRows = new Map();
  const planFile = seedFileName(snapshot.release);
  for (const entry of [...supplied.values(), ...empty.values()])
    if (!rows[entry.table])
      seedFailures.push(
        `${entry.table}: stale entry in ${planFile}: it is not a model table of smrt ${snapshot.release}. Remove it.`,
      );
  for (const entry of supplied.values()) {
    const known = snapshot.tables[entry.table]?.columns ?? {};
    for (const column of Object.keys(entry.row))
      if (rows[entry.table] && !known[column])
        seedFailures.push(
          `${entry.table}.${column}: stale supplied row in ${planFile}: the snapshot has no such column. Fix or remove it.`,
        );
  }
  await db.query('SET session_replication_role = replica');
  try {
    for (const [name, row] of Object.entries(rows)) {
      const table = snapshot.tables[name];
      let inserted;
      let genericError;
      try {
        inserted = await insertRow(db, name, row, table, true);
      } catch (error) {
        genericError = error;
      }
      if (!genericError) {
        // The generic row works, so the plan entry is no longer needed.
        if (supplied.has(name))
          seedFailures.push(
            `${name}: stale supplied row in ${planFile}: the generic seeder now seeds this table. Remove the entry.`,
          );
        if (empty.has(name))
          seedFailures.push(
            `${name}: stale emptyByDesign entry in ${planFile}: the table accepts a seeded row. Remove the entry.`,
          );
        insertedRows.set(name, inserted.rows[0]);
        seededTables++;
        continue;
      }
      if (empty.has(name)) continue;
      const entry = supplied.get(name);
      if (!entry) {
        seedFailures.push(
          `${name}: could not seed a row: ${genericError.message}. Supply a minimal row in ${planFile} or list the table as emptyByDesign with a reason.`,
        );
        continue;
      }
      if (Object.keys(entry.row).some((column) => !table.columns[column]))
        continue; // already reported as stale above
      try {
        inserted = await insertRow(db, name, entry.row, table, true);
        rows[name] = entry.row;
        insertedRows.set(name, inserted.rows[0]);
        seededTables++;
      } catch (error) {
        seedFailures.push(
          `${name}: the supplied row in ${planFile} could not be inserted: ${error.message} (the generic row failed with: ${genericError.message})`,
        );
      }
    }
    // Defaults are evaluated by PostgreSQL. Resolve required references to
    // those actual seeded values, including non-PK unique/default columns.
    for (const [name, table] of Object.entries(snapshot.tables)) {
      const inserted = insertedRows.get(name);
      if (!inserted) continue;
      const updates = new Map();
      for (const fk of table.constraints ?? []) {
        if (fk.type !== 'f') continue;
        const parent = insertedRows.get(fk.referencesTable);
        if (!parent) continue;
        fk.columns.forEach((column, i) => {
          if (!Object.hasOwn(rows[name], column)) return;
          const value = parent[fk.referencesColumns[i]];
          if (JSON.stringify(inserted[column]) !== JSON.stringify(value))
            updates.set(column, value);
        });
      }
      if (!updates.size) continue;
      const values = [...updates.values()];
      const set = [...updates.keys()].map(
        (column, i) => `${quote(column)}=$${i + 1}`,
      );
      const where = (table.primaryKey ?? []).map((column) => {
        values.push(inserted[column]);
        return `${quote(column)}=$${values.length}`;
      });
      try {
        await db.query(
          `UPDATE ${quote(name)} SET ${set.join(', ')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
          values,
        );
      } catch (error) {
        seedFailures.push(
          `${name}: could not align seeded foreign keys: ${error.message}`,
        );
      }
    }
    // Foreign keys are not enforced while seeding (replica role), so confirm the
    // rows would survive if they were: no seeded reference may point at nothing.
    for (const [name, table] of Object.entries(snapshot.tables)) {
      if (!insertedRows.has(name)) continue;
      for (const fk of table.constraints ?? []) {
        if (fk.type !== 'f') continue;
        const join = fk.columns
          .map(
            (column, i) =>
              `p.${quote(fk.referencesColumns[i])} = c.${quote(column)}`,
          )
          .join(' AND ');
        const present = fk.columns
          .map((column) => `c.${quote(column)} IS NOT NULL`)
          .join(' AND ');
        try {
          const { rows: dangling } = await db.query(
            `SELECT 1 FROM ${quote(name)} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${quote(fk.referencesTable)} p WHERE ${join}) LIMIT 1`,
          );
          if (dangling.length)
            seedFailures.push(
              `${name}.${fk.columns.join(',')}: the seeded value points at no row in ${fk.referencesTable} (${fk.name})`,
            );
        } catch (error) {
          seedFailures.push(
            `${name}.${fk.columns.join(',')}: could not check the seeded reference to ${fk.referencesTable}: ${error.message}`,
          );
        }
      }
    }
  } finally {
    await db.query('SET session_replication_role = origin');
  }
  return { seededTables, seedFailures };
}

function describeStops(result) {
  return [
    ...(result.stops ?? []).map(
      (stop) =>
        `${stop.change.table}.${stop.change.name ?? stop.change.foreignKey?.column ?? '(table)'}: ${stop.message} (${stop.reason})`,
    ),
    ...(result.packageStops ?? []).map((stop) => stop.message),
    ...(result.releaseStop ? [result.releaseStop.message] : []),
    ...(result.heldBack ?? []).map((held) => `Held back: ${held.description}`),
  ];
}
export function validateLeftovers(entries) {
  if (!Array.isArray(entries))
    throw new Error('leftover-columns.json must be an array');
  const seen = new Set();
  for (const entry of entries) {
    if (
      ![entry.table, entry.column, entry.since, entry.reason].every(
        (value) => typeof value === 'string' && value.trim(),
      )
    )
      throw new Error(
        'Each leftover column needs table, column, since and a non-empty reason',
      );
    compareReleases(entry.since, entry.since);
    const key = `${entry.table}.${entry.column}`;
    if (seen.has(key)) throw new Error(`Duplicate leftover entry: ${key}`);
    seen.add(key);
  }
  return entries;
}

export async function rehearse({
  snapshot,
  label = snapshot.release,
  root,
  build,
  leftovers = [],
  seedPlan,
  createDb,
  inspect,
  checkStaleLeftovers = true,
  onProgress = () => {},
}) {
  build ??= await loadBuild(root);
  validateLeftovers(leftovers);
  const failures = [];
  const matchedLeftovers = new Set();
  let seededTables = 0;
  let seedFailures = [];
  let db;
  let planned;
  try {
    onProgress(
      `${label}: restoring ${Object.keys(snapshot.tables).length} table(s)`,
    );
    db = await restore(snapshot, { root, createDb });
    ({ seededTables, seedFailures } = await seed(db, snapshot, seedPlan));
    onProgress(`${label}: seeded ${seededTables} table(s)`);
    // Rule 6: a table that holds no row proves nothing. The upgrade still runs
    // below so one run reports every problem, but the gate cannot pass.
    failures.push(
      ...seedFailures.map(
        (failure) => `Seeding smrt ${snapshot.release}: ${failure}`,
      ),
    );
    onProgress(`${label}: applying the upgrade`);
    const result = await build.migrateSmrtSchemas({
      db,
      packageName: '@happyvertical/release-gate',
      engineHint: 'postgres',
      postgresSafe: false,
      useConcurrentIndexes: false,
    });
    if (result.refused || result.hasManualDrift)
      failures.push(...describeStops(result));
    if (result.refused && !failures.length)
      failures.push('Migrate was refused without a reason');
    if (!result.refused) {
      onProgress(`${label}: checking convergence`);
      const pending = await build.getPendingSchemaStatements(db, {
        engineHint: 'postgres',
      });
      if (
        pending.hasChanges ||
        pending.hasManualDrift ||
        pending.statements.length
      ) {
        failures.push(`Migration did not converge from ${snapshot.release}`);
        failures.push(...describeStops(pending.decision));
        for (const change of pending.diff.changes)
          failures.push(
            `${change.table}.${change.name ?? '(table)'}: ${change.description ?? change.type}`,
          );
        failures.push(...pending.statements);
      }
    }
  } catch (error) {
    const statement =
      error.query ?? error.sql ?? error.statement ?? error.cause?.query;
    failures.push(
      `Upgrade from ${snapshot.release}: ${error.message}${statement ? `; statement: ${statement}` : ''}`,
    );
    if (db) {
      try {
        planned = await build.getPendingSchemaStatements(db, {
          engineHint: 'postgres',
        });
      } catch {
        /* Preserve the migration error when inspection also fails. */
      }
    }
    if (planned)
      failures.push(
        ...planned.statements.map((sql) => `Planned statement: ${sql}`),
      );
  }
  try {
    if (db) {
      const live = await introspect(db, snapshot.release, { normalize: false });
      const schemas = build.ObjectRegistry.getAllSchemasAsDefinitions();
      const systemShapes = getSystemTableShapes('postgres');
      const oldModels = new Set(
        snapshot.modelTables ??
          Object.keys(snapshot.tables).filter(
            (name) => !bookkeepingTables.has(name),
          ),
      );
      for (const [tableName, table] of Object.entries(live.tables)) {
        if (
          !schemas[tableName] &&
          !oldModels.has(tableName) &&
          !systemShapes.has(tableName)
        )
          continue;
        const declaredColumns =
          schemas[tableName]?.columns ??
          Object.fromEntries(
            (systemShapes.get(tableName)?.columns ?? []).map((column) => [
              column.name,
              column,
            ]),
          );
        for (const column of Object.keys(table.columns)) {
          if (!table.columns[column] || declaredColumns[column]) continue;
          const key = `${tableName}.${column}`;
          const meta = table.columns[column];
          const count = Number(
            (
              await db.query(
                `SELECT COUNT(*) AS n FROM ${quote(tableName)} WHERE ${quote(column)} IS NOT NULL`,
              )
            ).rows[0].n,
          );
          const entry = leftovers.find(
            (item) => item.table === tableName && item.column === column,
          );
          if (entry) matchedLeftovers.add(key);
          if (meta.notNull && meta.default == null)
            failures.push(
              `${key}: NOT NULL orphan without a default blocks new inserts (from smrt ${snapshot.release})`,
            );
          if (count && !entry)
            failures.push(
              `${key}: column no longer declared holds ${count} non-NULL row(s) from smrt ${snapshot.release}`,
            );
        }
      }
      await inspect?.(db);
    }
  } catch (error) {
    failures.push(`Inspect upgrade from ${snapshot.release}: ${error.message}`);
  } finally {
    await db?.close();
  }
  if (checkStaleLeftovers)
    for (const entry of leftovers)
      if (!matchedLeftovers.has(`${entry.table}.${entry.column}`))
        failures.push(`Stale leftover entry: ${entry.table}.${entry.column}`);
  return {
    label,
    release: snapshot.release,
    failures,
    seededTables,
    seedFailures,
    matchedLeftovers: [...matchedLeftovers],
    ok: failures.length === 0,
  };
}

export function selectPrevious(snapshots, current, compare) {
  const versions = snapshots
    .filter((version) => compare(version, current) <= 0)
    .sort(compare);
  if (!versions.length)
    throw new Error(`No release snapshot at or before ${current}`);
  return versions.at(-1);
}
export function validateOldest(directory, compare) {
  const record = readJSON(path.join(directory, 'oldest-supported.json'));
  if (
    !record.decision?.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.recordedAt) ||
    !Array.isArray(record.history)
  )
    throw new Error('Invalid oldest-supported.json decision, date or history');
  if (record.snapshot !== `snapshots/${record.release}.json`)
    throw new Error(
      'Oldest supported release must match its snapshot file name',
    );
  const snapshot = readJSON(path.join(directory, record.snapshot));
  if (snapshot.release !== record.release)
    throw new Error('Oldest supported release does not match snapshot.release');
  compare(record.release, record.release);
  if (record.history.length) {
    if (
      !record.upgradeFirstTo ||
      !record.decision.includes(`smrt ${record.upgradeFirstTo}`)
    )
      throw new Error(
        'Oldest supported decision must name the release older databases must upgrade to first',
      );
    const firstHop = readJSON(
      path.join(directory, `snapshots/${record.upgradeFirstTo}.json`),
    );
    if (firstHop.release !== record.upgradeFirstTo)
      throw new Error('First-hop release must match its snapshot');
    for (const previous of record.history) {
      if (
        !previous.decision?.trim() ||
        compare(previous.release, record.release) >= 0
      )
        throw new Error('Invalid oldest supported release history');
    }
  }
  return record;
}
export function snapshotVersions(directory) {
  if (!existsSync(path.join(directory, 'snapshots'))) return [];
  return readdirSync(path.join(directory, 'snapshots'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5));
}
export function prune(directory, oldest, compare) {
  const versions = snapshotVersions(directory).sort(compare);
  const keep = new Set([
    oldest,
    ...versions.filter((version) => version !== oldest).slice(-2),
  ]);
  // A first-hop snapshot is executable provenance, so keep it as well.
  const record = readJSON(path.join(directory, 'oldest-supported.json'));
  if (record.upgradeFirstTo) keep.add(record.upgradeFirstTo);
  for (const version of versions)
    if (!keep.has(version)) {
      unlinkSync(path.join(directory, `snapshots/${version}.json`));
      const plan = path.join(directory, seedFileName(version));
      if (existsSync(plan)) unlinkSync(plan);
    }
  return [...keep].sort(compare);
}
export function moveOldest({
  directory,
  to,
  upgradeFirstTo,
  reason,
  compare,
  recordedAt = new Date().toISOString().slice(0, 10),
}) {
  if (!to || !upgradeFirstTo || !reason?.trim())
    throw new Error(
      'move-oldest requires --to, --upgrade-first-to and --reason',
    );
  const previous = validateOldest(directory, compare);
  if (compare(to, previous.release) <= 0)
    throw new Error('Oldest supported release must move forward');
  for (const version of [to, upgradeFirstTo]) {
    const snapshot = readJSON(
      path.join(directory, `snapshots/${version}.json`),
    );
    if (snapshot.release !== version)
      throw new Error(`Snapshot does not match ${version}`);
  }
  if (
    compare(upgradeFirstTo, previous.release) < 0 ||
    compare(upgradeFirstTo, to) >= 0
  )
    throw new Error(
      'First upgrade release must be supported by the old floor and older than the new floor',
    );
  const { history, ...oldRecord } = previous;
  const next = {
    release: to,
    snapshot: `snapshots/${to}.json`,
    decision: `${reason.trim()} Older databases must first upgrade with smrt ${upgradeFirstTo}.`,
    upgradeFirstTo,
    recordedAt,
    history: [...history, oldRecord],
  };
  writeFileSync(
    path.join(directory, 'oldest-supported.json'),
    stableJSON(next),
  );
  return next;
}

export async function check({
  root,
  directory = path.join(root, 'packages/core/release-upgrade'),
  report = console.log,
}) {
  const build = await loadBuild(root);
  const versions = snapshotVersions(directory);
  if (!versions.length)
    throw new Error(
      'No release snapshots. Save the first supported release before checking upgrades.',
    );
  const oldest = validateOldest(directory, build.compareReleases);
  const previous = selectPrevious(
    versions,
    build.release,
    build.compareReleases,
  );
  const selected = [...new Set([previous, oldest.release])];
  report(
    `Previous: ${previous}; oldest supported: ${oldest.release}${selected.length === 1 ? ' (same snapshot; rehearsing once)' : ''}`,
  );
  const leftovers = validateLeftovers(
    readJSON(path.join(directory, 'leftover-columns.json')),
  );
  validateSeedFiles(directory, versions);
  const results = [];
  for (const release of selected) {
    const snapshot = readJSON(
      path.join(directory, `snapshots/${release}.json`),
    );
    if (snapshot.release !== release)
      throw new Error(`Snapshot file name does not match release ${release}`);
    const result = await rehearse({
      snapshot,
      root,
      build,
      leftovers,
      seedPlan: readSeedPlan(directory, release),
      label: release,
      checkStaleLeftovers: false,
      onProgress: report,
    });
    results.push(result);
    report(`${release}: seeded ${result.seededTables} table(s)`);
    for (const failure of result.failures)
      report(`FAIL ${release}: ${failure}`);
  }
  const matched = new Set(results.flatMap((result) => result.matchedLeftovers));
  const stale = leftovers.filter(
    (entry) => !matched.has(`${entry.table}.${entry.column}`),
  );
  for (const entry of stale)
    report(`FAIL stale leftover: ${entry.table}.${entry.column}`);
  const ok = results.every((result) => result.ok) && stale.length === 0;
  report(
    `Release upgrade gate: ${ok ? 'PASS' : 'FAIL'} (${results.length} starting release(s), ${results.reduce((n, result) => n + result.failures.length, stale.length)} failure(s))`,
  );
  return { ok, results, stale };
}

export async function save({ root, directory }) {
  const snapshot = await capture({ root });
  mkdirSync(path.join(directory, 'snapshots'), { recursive: true });
  const build = await loadBuild(root, { manifests: false });
  const compare = build.compareReleases ?? compareReleases;
  const oldest = validateOldest(directory, compare);
  writeFileSync(
    path.join(directory, `snapshots/${snapshot.release}.json`),
    stableJSON(snapshot),
  );
  // Every snapshot has its seed plan, empty until a table needs an entry.
  mkdirSync(path.join(directory, 'seed'), { recursive: true });
  if (!existsSync(path.join(directory, seedFileName(snapshot.release))))
    writeFileSync(
      path.join(directory, seedFileName(snapshot.release)),
      stableJSON(emptySeedPlan()),
    );
  return { snapshot, kept: prune(directory, oldest.release, compare) };
}
