// PostgreSQL: copy, dump, restore and swap an app's schema (#5187). Every
// statement here names its schemas explicitly, so the helpers run on the
// scoped handle of a worker or on a host-side admin connection alike. Nothing
// outside `engine/db/` may contain PostgreSQL-specific SQL.
//
// A copy is described once, from the catalog (`describeSchema`), and then
// executed three ways: copied inside the server (a draft fork or a publish
// rehearsal), written to a file (an undo snapshot: restore-only, no live
// tables), or read back from that file into a new schema (restore). One
// description means a fork and a restore cannot disagree about what a copy
// has to carry. The spike (#5184) found the obvious shortcut
// (`CREATE TABLE ... LIKE ... INCLUDING ALL` plus `INSERT ... SELECT`) loses
// foreign keys, policies and row-level-security flags, ownership and grants,
// leaves serial defaults pointing at the source's sequences, does not advance
// identity sequences and fails on generated columns. Each of those is an
// explicit statement below.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { EngineError, StaleFenceError } from '../errors.ts';
import {
  assertSchemaName,
  isSideSchema,
  sideOwnerComment,
} from './schema-name.ts';

/** A transaction (or a connection) that runs one statement at a time. */
export interface SqlRunner {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
/** What the copy helpers need: something that opens a transaction. */
export interface SqlDatabase {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
/**
 * A column type as `format_type` prints it: identifiers (letters, digits,
 * underscore, dot, space), a length or precision list, array brackets and
 * double-quoted names. Nothing else is ever interpolated into a restore's
 * `CAST(? AS <type>)`, so a dump that carries anything more is refused.
 */
const TYPE_PART = '(?:"[^"]{1,63}"|[A-Za-z_][A-Za-z0-9_ ]{0,62})';
const COLUMN_TYPE = new RegExp(
  String.raw`^${TYPE_PART}(?:\.${TYPE_PART})*(?:\(\s*\d{1,5}(?:\s*,\s*\d{1,5})?\s*\))?(?:\s[A-Za-z][A-Za-z0-9_ ]{0,40})?(?:\[\d{0,5}\])*$`,
  'u',
);

/** Refuse a dumped column type that is not a plain `format_type` result. */
export function assertColumnType(type: unknown): string {
  if (
    typeof type !== 'string' ||
    type.length > 128 ||
    !COLUMN_TYPE.test(type) ||
    /--|\/\*/.test(type)
  )
    throw new EngineError(
      'the dump is damaged: a column type is not a plain type name',
      'refused',
    );
  return type;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const asJson = <T>(v: unknown): T =>
  (typeof v === 'string' ? JSON.parse(v) : v) as T;
/** Stand-in for the target schema in a description; replaced when it runs. */
const TARGET = '"__smrt_target__"';
const render = (sql: string, schema: string) =>
  sql.split(TARGET).join(qi(schema));

export const DUMP_FORMAT = 1;
/** How long a swap or a drop waits for another session's lock before it gives up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

interface Acl {
  grantee: string;
  priv: string;
  grant: boolean;
}
/**
 * The statements that give a new object exactly the source's privileges. A
 * source with an explicit ACL (`has`) is reset first: a new function is
 * executable by PUBLIC until revoked, so granting only what the source lists
 * would widen a function whose PUBLIC execute was revoked. A source with no
 * explicit ACL keeps the new object's default, which is the source's too.
 */
const aclSql = (
  acls: Acl[] | null,
  on: string,
  columns?: string,
  has = true,
): string[] => {
  const out: string[] = [];
  if (has && acls !== null)
    out.push(
      `REVOKE ALL${columns ? ` (${columns})` : ''} ON ${on} FROM PUBLIC`,
    );
  for (const a of acls ?? [])
    out.push(
      `GRANT ${a.priv}${columns ? ` (${columns})` : ''} ON ${on} TO ${
        a.grantee === 'PUBLIC' ? 'PUBLIC' : qi(a.grantee)
      }${a.grant ? ' WITH GRANT OPTION' : ''}`,
    );
  return out;
};

export interface CopyTable {
  name: string;
  /** Columns the database stores (generated ones are recomputed). */
  columns: Array<{ name: string; type: string }>;
  /** Needs `OVERRIDING SYSTEM VALUE` to copy identity values. */
  overriding: boolean;
}
export interface SchemaPlan {
  /** Run in order, before any rows. */
  before: string[];
  tables: CopyTable[];
  /** Run in order, after the rows. */
  after: string[];
}

const asRows = (r: { rows: any[] }) => r.rows as Array<Record<string, any>>;

/**
 * What it takes to rebuild `source` as another schema, read from the catalog
 * inside `tx`. Refuses a schema holding anything it does not carry (views,
 * functions, types, triggers, partitions): a copy that silently drops one is
 * worse than none. The statements name `TARGET` where the new schema goes.
 */
export async function describeSchema(
  tx: SqlRunner,
  source: string,
): Promise<SchemaPlan> {
  const S = lit(source);
  const ns = `to_regnamespace(${S})`;
  const found = asRows(
    await tx.query(
      `SELECT pg_get_userbyid(nspowner) AS owner, current_user AS me, nspacl IS NOT NULL AS hasacl,
        (SELECT coalesce(json_agg(json_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, 'priv', x.privilege_type, 'grant', x.is_grantable)), '[]'::json)
           FROM aclexplode(nspacl) x WHERE x.grantee <> nspowner) AS acl, nspacl IS NOT NULL AS has
       FROM pg_namespace WHERE nspname = ${S}`,
    ),
  )[0];
  if (!found)
    throw new EngineError(`schema ${source} does not exist`, 'not_found');
  const me = String(found.me);
  // Deparsed expressions name an object without its schema when the schema is
  // on the search path: read them with the source there, run them with the
  // target there, and the same text means the copy's own objects.
  await tx.query(`SELECT set_config('search_path', ${lit(qi(source))}, true)`);

  const kinds = asRows(
    await tx.query(
      `SELECT
        (SELECT coalesce(string_agg(DISTINCT c.relkind::text, ','), '') FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind NOT IN ('r','i','S')) AS badkinds,
        (SELECT string_agg(proname::text, ', ') FROM pg_proc p WHERE pronamespace = ${ns} AND (p.prokind <> 'f' OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))) AS procs,
        (SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = ${ns} AND t.typtype IN ('e','d','r','m')) AS types,
        (SELECT count(*)::int FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = ${ns} AND NOT g.tgisinternal) AS triggers,
        (SELECT count(*)::int FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE c.relnamespace = ${ns}) AS inherits,
        (SELECT count(*)::int FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class WHERE c.relnamespace = ${ns}) AS rules`,
    ),
  )[0];
  const unsupported = [
    kinds.badkinds && `objects of kind ${kinds.badkinds}`,
    kinds.procs &&
      `procedures, aggregates or extension functions (${kinds.procs})`,
    kinds.types > 0 && 'types',
    kinds.triggers > 0 && 'triggers',
    kinds.inherits > 0 && 'inheritance or partitions',
    kinds.rules > 0 && 'rules',
  ].filter(Boolean);
  if (unsupported.length)
    throw new EngineError(
      `schema ${source} holds ${unsupported.join(', ')}, which a copy does not carry; refusing rather than dropping them`,
      'refused',
    );

  const relations = asRows(
    await tx.query(
      `SELECT c.oid::int8::text AS oid, c.relname AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner,
        obj_description(c.oid, 'pg_class') AS comment, c.relrowsecurity AS rls, c.relforcerowsecurity AS frls,
        (SELECT coalesce(json_agg(json_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, 'priv', x.privilege_type, 'grant', x.is_grantable)), '[]'::json)
           FROM aclexplode(c.relacl) x WHERE x.grantee <> c.relowner) AS acl, c.relacl IS NOT NULL AS has
       FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind IN ('r','S') ORDER BY c.relname`,
    ),
  );
  const tables = relations.filter((r) => r.kind === 'r');
  const sequences = asRows(
    await tx.query(
      `SELECT s.relname AS name, format_type(ps.seqtypid, NULL) AS type, ps.seqstart::text AS start, ps.seqincrement::text AS inc,
        ps.seqmin::text AS min, ps.seqmax::text AS max, ps.seqcache::text AS cache, ps.seqcycle AS cycle,
        d.deptype AS dep, t.relname AS tbl, a.attname AS col, a.attnum AS attnum, d.refobjid::int8::text AS tbloid,
        (SELECT q.last_value::text FROM pg_sequences q WHERE q.schemaname = ${S} AND q.sequencename = s.relname) AS last
       FROM pg_class s JOIN pg_sequence ps ON ps.seqrelid = s.oid
       LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0 AND d.deptype IN ('a','i')
       LEFT JOIN pg_class t ON t.oid = d.refobjid
       LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       WHERE s.relnamespace = ${ns} AND s.relkind = 'S' ORDER BY s.relname`,
    ),
  );
  const seqOptions = (s: Record<string, any>) =>
    `INCREMENT BY ${s.inc} MINVALUE ${s.min} MAXVALUE ${s.max} START WITH ${s.start} CACHE ${s.cache} ${s.cycle ? '' : 'NO '}CYCLE`;
  const identity = new Map<string, Record<string, any>>();
  for (const s of sequences)
    if (s.dep === 'i') identity.set(`${s.tbloid}:${s.attnum}`, s);

  const columns = asRows(
    await tx.query(
      `SELECT c.oid::int8::text AS tbl, a.attnum, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull AS notnull, a.attidentity AS identity, a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS def,
        CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN co.collname END AS coll,
        CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN cn.nspname END AS collns,
        col_description(c.oid, a.attnum) AS comment,
        (SELECT coalesce(json_agg(json_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, 'priv', x.privilege_type, 'grant', x.is_grantable)), '[]'::json)
           FROM aclexplode(a.attacl) x WHERE x.grantee <> c.relowner) AS acl, a.attacl IS NOT NULL AS has
       FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
       LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
       WHERE c.relnamespace = ${ns} AND c.relkind = 'r' ORDER BY c.relname, a.attnum`,
    ),
  );

  const before: string[] = [];
  const after: string[] = [];
  const grants: string[] = [];
  const owners: string[] = [];
  const setvals: string[] = [];

  before.push(`CREATE SCHEMA ${TARGET}`);
  grants.push(
    ...aclSql(asJson(found.acl), `SCHEMA ${TARGET}`, undefined, found.has),
  );

  // Sequences a column default or an owner refers to, before the tables.
  for (const s of sequences) {
    if (s.dep === 'i') continue;
    before.push(
      `CREATE SEQUENCE ${TARGET}.${qi(s.name)} AS ${s.type} ${seqOptions(s)}`,
    );
    if (s.dep === 'a' && s.tbl)
      after.push(
        `ALTER SEQUENCE ${TARGET}.${qi(s.name)} OWNED BY ${TARGET}.${qi(s.tbl)}.${qi(s.col)}`,
      );
    if (s.last != null)
      setvals.push(
        `SELECT setval('${TARGET}.${qi(s.name)}', ${String(s.last)}, true)`,
      );
  }

  const plan: CopyTable[] = [];
  for (const t of tables) {
    const cols = columns.filter((c) => c.tbl === t.oid);
    const defs = cols.map((c) => {
      let sql = `${qi(c.name)} ${c.type}`;
      if (c.coll)
        sql += ` COLLATE ${c.collns && c.collns !== 'pg_catalog' ? `${qi(c.collns)}.` : ''}${qi(c.coll)}`;
      if (c.generated === 's') sql += ` GENERATED ALWAYS AS (${c.def}) STORED`;
      else if (c.generated === 'v') sql += ` GENERATED ALWAYS AS (${c.def})`;
      else if (c.identity) {
        const s = identity.get(`${t.oid}:${c.attnum}`);
        sql += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${s ? ` (${seqOptions(s)})` : ''}`;
        if (s?.last != null)
          setvals.push(
            `SELECT setval(pg_get_serial_sequence('${TARGET}.${qi(t.name)}', ${lit(c.name)}), ${String(s.last)}, true)`,
          );
      } else if (c.def != null) sql += ` DEFAULT ${c.def}`;
      if (c.notnull) sql += ' NOT NULL';
      return sql;
    });
    before.push(`CREATE TABLE ${TARGET}.${qi(t.name)} (${defs.join(', ')})`);
    plan.push({
      name: t.name,
      columns: cols
        .filter((c) => !c.generated)
        .map((c) => ({ name: c.name, type: c.type })),
      overriding: cols.some((c) => c.identity === 'a'),
    });
    if (t.comment != null)
      after.push(
        `COMMENT ON TABLE ${TARGET}.${qi(t.name)} IS ${lit(t.comment)}`,
      );
    for (const c of cols) {
      if (c.comment != null)
        after.push(
          `COMMENT ON COLUMN ${TARGET}.${qi(t.name)}.${qi(c.name)} IS ${lit(c.comment)}`,
        );
      grants.push(
        ...aclSql(
          asJson(c.acl),
          `TABLE ${TARGET}.${qi(t.name)}`,
          qi(c.name),
          c.has,
        ),
      );
    }
    grants.push(
      ...aclSql(
        asJson(t.acl),
        `TABLE ${TARGET}.${qi(t.name)}`,
        undefined,
        t.has,
      ),
    );
    if (t.owner !== me)
      owners.push(
        `ALTER TABLE ${TARGET}.${qi(t.name)} OWNER TO ${qi(t.owner)}`,
      );
  }
  for (const s of relations.filter((r) => r.kind === 'S')) {
    grants.push(
      ...aclSql(
        asJson(s.acl),
        `SEQUENCE ${TARGET}.${qi(s.name)}`,
        undefined,
        s.has,
      ),
    );
    const meta = sequences.find((q) => q.name === s.name);
    // A sequence a column owns changes hands with its table.
    if (s.owner !== me && !meta?.dep)
      owners.push(
        `ALTER SEQUENCE ${TARGET}.${qi(s.name)} OWNER TO ${qi(s.owner)}`,
      );
  }

  // Constraints (keys and checks first, then foreign keys once every table
  // and its key exists) and plain indexes, with the source's own names.
  const constraints = asRows(
    await tx.query(
      `SELECT c.conname AS name, c.contype AS type, r.relname AS tbl, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
       WHERE c.connamespace = ${ns} AND r.relkind = 'r' AND c.contype IN ('p','u','x','c','f') ORDER BY r.relname, c.conname`,
    ),
  );
  const addConstraint = (c: Record<string, any>) =>
    `ALTER TABLE ${TARGET}.${qi(c.tbl)} ADD CONSTRAINT ${qi(c.name)} ${c.def}`;
  for (const c of constraints)
    if (c.type === 'p' || c.type === 'u' || c.type === 'x')
      after.push(addConstraint(c));
  const indexes = asRows(
    await tx.query(
      `SELECT ic.relname AS name, tc.relname AS tbl, pg_get_indexdef(i.indexrelid) AS def, i.indisunique AS uniq
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class tc ON tc.oid = i.indrelid
       WHERE tc.relnamespace = ${ns} AND tc.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p','u','x'))
       ORDER BY tc.relname, ic.relname`,
    ),
  );
  for (const i of indexes) {
    // The deparsed statement names the source table; keep only what follows.
    const using = String(i.def).indexOf(' USING ');
    after.push(
      `CREATE ${i.uniq ? 'UNIQUE ' : ''}INDEX ${qi(i.name)} ON ${TARGET}.${qi(i.tbl)}${String(i.def).slice(using)}`,
    );
  }
  for (const c of constraints) if (c.type === 'c') after.push(addConstraint(c));
  for (const c of constraints) if (c.type === 'f') after.push(addConstraint(c));

  // Plain functions (core keeps its change-feed helpers in the app's schema):
  // the definition with its own schema swapped for the target, then its owner
  // and who may execute it.
  const functions = asRows(
    await tx.query(
      `SELECT pg_get_functiondef(p.oid) AS def, quote_ident(n.nspname) AS qns, p.proname AS name,
        pg_get_function_identity_arguments(p.oid) AS args, pg_get_userbyid(p.proowner) AS owner,
        (SELECT coalesce(json_agg(json_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, 'priv', x.privilege_type, 'grant', x.is_grantable)), '[]'::json)
           FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl, p.proacl IS NOT NULL AS has
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.pronamespace = ${ns} AND p.prokind = 'f' ORDER BY p.proname, p.oid`,
    ),
  );
  for (const f of functions) {
    const head = `CREATE OR REPLACE FUNCTION ${f.qns}.`;
    if (!String(f.def).startsWith(head))
      throw new EngineError(
        `function ${f.name} in ${source} has a definition a copy cannot move`,
        'refused',
      );
    const signature = `${TARGET}.${qi(f.name)}(${f.args})`;
    after.push(
      `CREATE OR REPLACE FUNCTION ${TARGET}.${String(f.def).slice(head.length)}`,
    );
    grants.push(
      ...aclSql(asJson(f.acl), `FUNCTION ${signature}`, undefined, f.has),
    );
    if (f.owner !== me)
      owners.push(`ALTER FUNCTION ${signature} OWNER TO ${qi(f.owner)}`);
  }

  // Row-level security: the flags and every policy, which a copy drops.
  for (const t of tables) {
    if (t.rls)
      after.push(
        `ALTER TABLE ${TARGET}.${qi(t.name)} ENABLE ROW LEVEL SECURITY`,
      );
    if (t.frls)
      after.push(
        `ALTER TABLE ${TARGET}.${qi(t.name)} FORCE ROW LEVEL SECURITY`,
      );
  }
  const policies = asRows(
    await tx.query(
      `SELECT p.polname AS name, c.relname AS tbl, p.polcmd AS cmd, p.polpermissive AS permissive,
        (SELECT coalesce(json_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END), '[]'::json) FROM unnest(p.polroles) r) AS roles,
        pg_get_expr(p.polqual, p.polrelid) AS using_, pg_get_expr(p.polwithcheck, p.polrelid) AS check_
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = ${ns} ORDER BY c.relname, p.polname`,
    ),
  );
  const CMD: Record<string, string> = {
    '*': 'ALL',
    r: 'SELECT',
    a: 'INSERT',
    w: 'UPDATE',
    d: 'DELETE',
  };
  for (const p of policies) {
    const roles = asJson<string[]>(p.roles).map((r) =>
      r === 'PUBLIC' ? 'PUBLIC' : qi(r),
    );
    after.push(
      `CREATE POLICY ${qi(p.name)} ON ${TARGET}.${qi(p.tbl)} AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${CMD[p.cmd]} TO ${roles.join(', ') || 'PUBLIC'}${p.using_ != null ? ` USING (${p.using_})` : ''}${p.check_ != null ? ` WITH CHECK (${p.check_})` : ''}`,
    );
  }

  // Default privileges of the schema.
  const defaults = asRows(
    await tx.query(
      `SELECT pg_get_userbyid(d.defaclrole) AS role, d.defaclobjtype AS kind,
        (SELECT coalesce(json_agg(json_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, 'priv', x.privilege_type, 'grant', x.is_grantable)), '[]'::json)
           FROM aclexplode(d.defaclacl) x) AS acl
       FROM pg_default_acl d WHERE d.defaclnamespace = ${ns} AND d.defaclobjtype IN ('r','S','f')`,
    ),
  );
  const defaultGrants: string[] = [];
  for (const d of defaults)
    for (const a of asJson<Acl[]>(d.acl))
      defaultGrants.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(d.role)} IN SCHEMA ${TARGET} GRANT ${a.priv} ON ${d.kind === 'S' ? 'SEQUENCES' : d.kind === 'f' ? 'FUNCTIONS' : 'TABLES'} TO ${a.grantee === 'PUBLIC' ? 'PUBLIC' : qi(a.grantee)}${a.grant ? ' WITH GRANT OPTION' : ''}`,
      );

  if (found.owner !== me)
    owners.push(`ALTER SCHEMA ${TARGET} OWNER TO ${qi(found.owner)}`);
  // Sequence positions last, after every row that could have moved them.
  return {
    before,
    tables: plan,
    after: [...after, ...setvals, ...grants, ...owners, ...defaultGrants],
  };
}

/** Run a description's statements (not its rows) with the target schema on the search path. */
async function run(tx: SqlRunner, sql: string[], target: string) {
  await tx.query(`SELECT set_config('search_path', ${lit(qi(target))}, true)`);
  for (const s of sql) await tx.query(render(s, target));
}

const columnList = (cols: Array<{ name: string }>) =>
  cols.map((c) => qi(c.name)).join(', ');

/**
 * A copy must never read through a row-level-security policy that hides rows:
 * it would drop them, silently. The tables of an app carry policies that are
 * FORCED (they hold for their owner too, #5189), and `row_security = off`
 * would make the server fail every such read, so the copy instead acts as the
 * engine: `smrt.system_context` is what the policies' bypass reads. Trusted
 * engine code only sets it, on a connection it opened for the copy. When
 * `source` is given the policies are checked first: a table whose row-level
 * security applies to this role (`row_security_active`) but has no policy that
 * passes the bypass would hide its rows, so the copy is refused instead.
 */
export const readAllRows = async (tx: SqlRunner, source?: string) => {
  await tx.query(`SELECT set_config('smrt.system_context', 'true', true)`);
  await tx.query(`SELECT set_config('smrt.super_admin_bypass', 'false', true)`);
  if (source !== undefined) {
    // A table is covered when a permissive policy for reads AND one for
    // inserts (a copy writes too) pass the engine's bypass.
    const hidden = asRows(
      await tx.query(
        `SELECT c.relname AS name FROM pg_class c
          WHERE c.relnamespace = to_regnamespace(${lit(source)}) AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND row_security_active(c.oid)
            AND (NOT EXISTS (
                  SELECT 1 FROM pg_policy p
                   WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd IN ('*', 'r')
                     AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%smrt_rls_bypass()%')
              OR NOT EXISTS (
                  SELECT 1 FROM pg_policy p
                   WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd IN ('*', 'a')
                     AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%smrt_rls_bypass()%'))
          ORDER BY c.relname`,
      ),
    );
    if (hidden.length)
      throw new EngineError(
        `cannot copy ${source}: row-level security on ${hidden
          .map((r) => r.name)
          .join(', ')} would hide rows from the copy`,
        'refused',
      );
  }
  // Values travel as text: read and written in one fixed format whatever the
  // session's own settings are.
  await tx.query(`SELECT set_config('datestyle', 'ISO, MDY', true)`);
  await tx.query(`SELECT set_config('intervalstyle', 'postgres', true)`);
  await tx.query(`SELECT set_config('bytea_output', 'hex', true)`);
};

/**
 * Make a copy of `source` ONE point in time. The transaction cannot ask for a
 * REPEATABLE READ snapshot (the scoped handle fixes its isolation level), so
 * each table read would otherwise see its own READ COMMITTED snapshot and a
 * concurrent writer could leave a parent and its child from different moments:
 * a fork whose foreign keys fail, or an undo point that cannot be restored.
 * Instead every table is locked IN SHARE MODE (reads continue, writers wait)
 * BEFORE the first read, in one fixed order (sorted by name in the C collation)
 * so two copies cannot deadlock each other, waiting at most `lockTimeoutMs`
 * per table: a writer that will not let go surfaces as a lock-timeout error
 * (the transaction rolls back, the connection is released, nothing is left).
 * A role needs UPDATE, DELETE or TRUNCATE on a table to take this lock.
 */
export async function lockForCopy(
  tx: SqlRunner,
  source: string,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
) {
  await tx.query(
    `SELECT set_config('lock_timeout', ${lit(`${Math.floor(lockTimeoutMs)}ms`)}, true)`,
  );
  const tables = asRows(
    await tx.query(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = to_regnamespace(${lit(source)}) AND c.relkind IN ('r', 'p') ORDER BY c.relname COLLATE "C"`,
    ),
  );
  for (const t of tables)
    await tx.query(`LOCK TABLE ${qi(source)}.${qi(t.name)} IN SHARE MODE`);
}

/** Mark `schema` as a copy that belongs to the app whose FULL schema name is `owner`. */
const claim = (tx: SqlRunner, schema: string, owner: string) =>
  tx.query(
    `COMMENT ON SCHEMA ${qi(schema)} IS ${lit(sideOwnerComment(owner))}`,
  );

/** Refuse unless `schema` is a copy that belongs to `owner` (its comment says so). */
async function assertClaimed(tx: SqlRunner, schema: string, owner: string) {
  const found = asRows(
    await tx.query(
      `SELECT obj_description(to_regnamespace(${lit(schema)}), 'pg_namespace') AS owner`,
    ),
  )[0];
  if (found?.owner !== sideOwnerComment(owner))
    throw new EngineError(
      `${schema} is not a copy made for ${owner}; not touching it`,
      'refused',
    );
}

/** The side schemas of `base` (`sideSchemaName`'s), of the given tags. */
export async function listSideSchemas(
  db: SqlDatabase,
  base: string,
  tags: string,
): Promise<string[]> {
  const found = await db.transaction(async (tx: SqlRunner) =>
    asRows(
      await tx.query(
        `SELECT nspname, obj_description(oid, 'pg_namespace') AS owner FROM pg_namespace WHERE nspname ~ '__[dron][a-z0-9]{16}$'`,
      ),
    ),
  );
  return found
    .filter(
      (r) =>
        isSideSchema(String(r.nspname), base, tags) &&
        r.owner === sideOwnerComment(base),
    )
    .map((r) => String(r.nspname));
}

/** The namespace half of an app's advisory lock key (the other half is the app's schema). */
const APP_LOCK_NAMESPACE = 'smrt-app-shell';
const appLockKey = (schema: string) =>
  `hashtext(${lit(APP_LOCK_NAMESPACE)}), hashtext(${lit(schema)})`;

/**
 * The `pg_locks` predicate that finds the granted session lock of `schema`'s
 * app claim (`pg_try_advisory_lock(int, int)` is `objsubid = 2`; the keys are
 * stored as unsigned 32-bit values).
 */
export const appLockMatch = (schema: string) =>
  `locktype = 'advisory' AND granted AND objsubid = 2 AND classid::bigint = (hashtext(${lit(APP_LOCK_NAMESPACE)})::bigint & 4294967295) AND objid::bigint = (hashtext(${lit(assertSchemaName(schema))})::bigint & 4294967295)`;

/**
 * Take the session-level advisory lock that says "this process hosts app
 * `schema`" (#5187). It is held by the session that took it until that
 * session ends, so the caller keeps one connection open for the host's life.
 * False when another session already holds it: a second host for the same app
 * would sweep and recover over the first one's live side schemas.
 */
export async function tryAppLock(db: SqlRunner, schema: string) {
  assertSchemaName(schema);
  const got = asRows(
    await db.query(`SELECT pg_try_advisory_lock(${appLockKey(schema)}) AS got`),
  )[0]?.got;
  return got === true || got === 't' || got === 'true';
}

/** Give the lock back early (closing the session does the same). */
export const releaseAppLock = (db: SqlRunner, schema: string) =>
  db.query(`SELECT pg_advisory_unlock(${appLockKey(schema)})`);

/** The key of the ownership generation in an app's `_app_meta` (#5190). */
const FENCE_KEY = 'fence';

/**
 * Take ownership of `schema`: advance its generation by one, creating it (at 1)
 * the first time. Every worker of an earlier owner then fails its next
 * transaction with a stale-fence error (`scopeDatabase`). Returns the new
 * generation; the caller holds it and hands it to its workers.
 */
export async function acquireOwnership(
  db: SqlDatabase,
  schema: string,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<number> {
  assertSchemaName(schema);
  return db.transaction(async (tx: SqlRunner) => {
    await tx.query(
      `SELECT set_config('lock_timeout', ${lit(`${Math.floor(lockTimeoutMs)}ms`)}, true)`,
    );
    if (!(await schemaExists(tx, schema)))
      throw new EngineError(
        `schema ${schema} does not exist; the host creates an app's schema before it starts`,
        'refused',
      );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${qi(schema)}._app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const got = asRows(
      await tx.query(
        `INSERT INTO ${qi(schema)}._app_meta AS m (key, value) VALUES (${lit(FENCE_KEY)}, '1') ON CONFLICT (key) DO UPDATE SET value = (m.value::bigint + 1)::text RETURNING value`,
      ),
    )[0];
    return Number(got.value);
  });
}

/** Exclusive lock on the fence's table: waits for every transaction that checked it (they hold it shared). */
async function lockFence(tx: SqlRunner, schema: string) {
  const has = asRows(
    await tx.query(
      `SELECT to_regclass(${lit(`${qi(schema)}._app_meta`)}) IS NOT NULL AS has`,
    ),
  )[0];
  if (has?.has)
    await tx.query(
      `LOCK TABLE ${qi(schema)}._app_meta IN ACCESS EXCLUSIVE MODE`,
    );
}

/** The generation stored in `schema`, or null when it has none (an app no host owns yet). */
async function readFence(
  tx: SqlRunner,
  schema: string,
): Promise<number | null> {
  const has = asRows(
    await tx.query(
      `SELECT to_regclass(${lit(`${qi(schema)}._app_meta`)}) IS NOT NULL AS has`,
    ),
  )[0];
  if (!has?.has) return null;
  const row = asRows(
    await tx.query(
      `SELECT value FROM ${qi(schema)}._app_meta WHERE key = ${lit(FENCE_KEY)}`,
    ),
  )[0];
  return row ? Number(row.value) : null;
}

/**
 * Take every privilege on the tables and sequences of `schema` away from
 * PUBLIC and the connected role, in a transaction of its own. Run on a swapped-out
 * (aside) schema before it is dropped: a session that still holds a plan on
 * the old tables then fails with permission denied instead of writing to data
 * nobody reads. Only for a schema that will not be swapped back.
 */
export async function revokeSchema(
  db: SqlDatabase,
  schema: string,
  owner: string,
) {
  assertSchemaName(schema);
  await db.transaction(async (tx: SqlRunner) => {
    if (!(await schemaExists(tx, schema))) return;
    await assertClaimed(tx, schema, owner);
    for (const kind of ['TABLES', 'SEQUENCES'])
      await tx.query(
        `REVOKE ALL ON ALL ${kind} IN SCHEMA ${qi(schema)} FROM PUBLIC, CURRENT_USER`,
      );
    await tx.query(
      `REVOKE ALL ON SCHEMA ${qi(schema)} FROM PUBLIC, CURRENT_USER`,
    );
  });
}

/** True when `schema` exists. */
export async function schemaExists(tx: SqlRunner, schema: string) {
  return (
    asRows(
      await tx.query(
        `SELECT 1 AS x FROM pg_namespace WHERE nspname = ${lit(schema)}`,
      ),
    ).length > 0
  );
}

/**
 * A live, queryable copy of `source` named `target` (a draft or a publish
 * rehearsal): every table with its rows, keys, defaults, sequences, policies,
 * ownership and grants. One transaction: a failure leaves no `target`.
 */
export async function forkSchema(
  db: SqlDatabase,
  source: string,
  target: string,
  owner?: string,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<void> {
  assertSchemaName(source);
  assertSchemaName(target);
  await db.transaction(async (tx: SqlRunner) => {
    if (await schemaExists(tx, target))
      throw new EngineError(`schema ${target} already exists`, 'refused');
    await lockForCopy(tx, source, lockTimeoutMs);
    await readAllRows(tx, source);
    const plan = await describeSchema(tx, source);
    await run(tx, plan.before, target);
    for (const t of plan.tables) {
      const cols = columnList(t.columns);
      if (!t.columns.length) continue;
      await tx.query(
        `INSERT INTO ${qi(target)}.${qi(t.name)} (${cols})${t.overriding ? ' OVERRIDING SYSTEM VALUE' : ''} SELECT ${cols} FROM ${qi(source)}.${qi(t.name)}`,
      );
    }
    await run(tx, plan.after, target);
    if (owner) await claim(tx, target, owner);
  });
}

/** Remove a schema and everything in it; waits at most `lockTimeoutMs` for other sessions. */
export async function dropSchema(
  db: SqlDatabase,
  schema: string,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  owner?: string,
  /**
   * The ownership generation the caller holds on `schema` (a draft's own
   * schema). Checked under an exclusive lock on its `_app_meta`, in the same
   * transaction as the drop: a caller that lost ownership drops nothing.
   */
  expectFence?: number,
) {
  assertSchemaName(schema);
  await db.transaction(async (tx: SqlRunner) => {
    await tx.query(
      `SELECT set_config('lock_timeout', ${lit(`${Math.floor(lockTimeoutMs)}ms`)}, true)`,
    );
    if (owner && (await schemaExists(tx, schema)))
      await assertClaimed(tx, schema, owner);
    if (expectFence !== undefined && (await schemaExists(tx, schema))) {
      await lockFence(tx, schema);
      const held = await readFence(tx, schema);
      if (held !== expectFence)
        throw new StaleFenceError(
          `this host no longer owns ${schema} (it holds generation ${expectFence}, the database is at ${held ?? 'none'}); nothing was dropped`,
          { schema, expected: expectFence, actual: held },
        );
    }
    await tx.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
  });
}

/** The key of a publish's readiness record in an app's `_app_meta` (#5470). */
const PUBLISHED_KEY = 'published';

/**
 * Which publish's new worker was last brought up on `schema` (its journal id),
 * or null. A worker that started on the published data is the point after
 * which the publish may have been served and must never be rolled back.
 */
export async function readPublished(
  db: SqlDatabase,
  schema: string,
): Promise<string | null> {
  assertSchemaName(schema);
  return db.transaction(async (tx: SqlRunner) => {
    const rows = asRows(
      await tx.query(
        `SELECT value FROM ${qi(schema)}._app_meta WHERE key = ${lit(PUBLISHED_KEY)}`,
      ),
    );
    return rows.length ? String(rows[0].value) : null;
  });
}

/**
 * Record that publish `id` is up on `schema`. An upsert: a fork copies
 * `_app_meta`, so a value from an earlier publish may already be there.
 */
export async function markPublished(
  db: SqlDatabase,
  schema: string,
  id: string,
): Promise<void> {
  assertSchemaName(schema);
  await db.transaction(async (tx: SqlRunner) => {
    await tx.query(
      `INSERT INTO ${qi(schema)}._app_meta (key, value) VALUES (${lit(PUBLISHED_KEY)}, ${lit(id)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
  });
}

/**
 * Replace `live` by `next` in one transaction: `live` is renamed to `aside`
 * and `next` to `live`. Every table of both is locked first (waiting at most
 * `lockTimeoutMs`), so a session still working on the old objects makes the
 * swap fail and change nothing, instead of being left on a renamed schema.
 * Callers retire their own workers first.
 */
export async function swapSchemas(
  db: SqlDatabase,
  names: {
    live: string;
    next: string;
    aside: string;
    owner: string;
    /**
     * The ownership generation the caller holds. Checked under the table
     * locks: a caller that is no longer the owner changes nothing and gets a
     * `StaleFenceError`. Omit only for a caller with no generation (SQLite
     * never reaches here).
     */
    expectFence?: number;
    /**
     * Runs in the swap's own transaction, after the rename and the new
     * generation, before COMMIT (#5470: the version store's write). A throw
     * rolls the whole swap back.
     */
    within?: (tx: SqlRunner) => Promise<void>;
  },
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<{ fence: number | null }> {
  const { live, next, aside, owner } = names;
  for (const n of [live, next, aside]) assertSchemaName(n);
  return db.transaction(async (tx: SqlRunner) => {
    await tx.query(
      `SELECT set_config('lock_timeout', ${lit(`${Math.floor(lockTimeoutMs)}ms`)}, true)`,
    );
    if (!(await schemaExists(tx, live)) || !(await schemaExists(tx, next)))
      throw new EngineError(
        `cannot swap: ${(await schemaExists(tx, live)) ? next : live} does not exist`,
        'refused',
      );
    if (await schemaExists(tx, aside))
      throw new EngineError(`schema ${aside} already exists`, 'refused');
    await assertClaimed(tx, next, owner);
    for (const schema of [live, next]) {
      const tables = asRows(
        await tx.query(
          `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = to_regnamespace(${lit(schema)}) AND c.relkind = 'r' ORDER BY 1`,
        ),
      );
      for (const t of tables)
        await tx.query(
          `LOCK TABLE ${qi(schema)}.${qi(t.name)} IN ACCESS EXCLUSIVE MODE`,
        );
    }
    // Under the locks nothing can move the generation: this is the owner's
    // last chance to find out it is not the owner any more.
    const held = await readFence(tx, live);
    const expected = names.expectFence;
    if (expected !== undefined && held !== expected)
      throw new StaleFenceError(
        `this host no longer owns the app in schema ${live} (it holds generation ${expected}, the database is at ${held ?? 'none'}); the swap changed nothing`,
        { schema: live, expected, actual: held },
      );
    await tx.query(`ALTER SCHEMA ${qi(live)} RENAME TO ${qi(aside)}`);
    await tx.query(`ALTER SCHEMA ${qi(next)} RENAME TO ${qi(live)}`);
    await claim(tx, aside, owner);
    await tx.query(`COMMENT ON SCHEMA ${qi(live)} IS NULL`);
    // The new live data is a new generation, in the same transaction as the
    // rename: every worker of the old one now reads a different number.
    let fence: number | null = null;
    if (held !== null) {
      fence = held + 1;
      await tx.query(
        `CREATE TABLE IF NOT EXISTS ${qi(live)}._app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      await tx.query(
        `INSERT INTO ${qi(live)}._app_meta (key, value) VALUES (${lit(FENCE_KEY)}, ${lit(String(fence))}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    }
    await names.within?.(tx);
    return { fence };
  });
}

// ---------- dump and restore (undo snapshots) ----------

/** Rows per INSERT when restoring (bounded by the parameter limit too). */
const ROWS_PER_INSERT = 200;
const FETCH_ROWS = 2000;

interface DumpHeader {
  k: 'header';
  format: number;
  schema: string;
  takenAt: string;
  /** `_app_meta.version` at the time, when the app has recorded one. */
  version: number | null;
}
type DumpLine =
  | DumpHeader
  | { k: 'sql'; phase: 'before' | 'after'; sql: string }
  | {
      k: 'table';
      name: string;
      columns: CopyTable['columns'];
      overriding: boolean;
    }
  | { k: 'rows'; name: string; rows: Array<Array<string | null>> };

/**
 * Write `source` to `file`: its description and its rows (every value as the
 * database's own text, so no type is guessed). A dump is the cold form of a
 * copy: it adds no tables to the database, and is only ever read back by
 * {@link restoreDump}.
 */
export async function dumpSchema(
  db: SqlDatabase,
  source: string,
  file: string,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<{ version: number | null }> {
  assertSchemaName(source);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'wx', 0o600);
  let ok = false;
  const put = (line: DumpLine) => writeSync(fd, `${JSON.stringify(line)}\n`);
  try {
    const version = await db.transaction(async (tx: SqlRunner) => {
      await lockForCopy(tx, source, lockTimeoutMs);
      await readAllRows(tx, source);
      const plan = await describeSchema(tx, source);
      const meta = asRows(
        await tx.query(
          `SELECT to_regclass(${lit(`${qi(source)}._app_meta`)}) IS NOT NULL AS has`,
        ),
      )[0];
      let version: number | null = null;
      if (meta?.has) {
        const v = asRows(
          await tx.query(
            `SELECT value FROM ${qi(source)}._app_meta WHERE key = 'version'`,
          ),
        )[0];
        if (v) version = Number(v.value);
      }
      put({
        k: 'header',
        format: DUMP_FORMAT,
        schema: source,
        takenAt: new Date().toISOString(),
        version,
      });
      for (const sql of plan.before) put({ k: 'sql', phase: 'before', sql });
      let n = 0;
      for (const t of plan.tables) {
        put({
          k: 'table',
          name: t.name,
          columns: t.columns,
          overriding: t.overriding,
        });
        if (!t.columns.length) continue;
        const cursor = `smrt_dump_${n++}`;
        await tx.query(
          `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${t.columns
            .map((c, i) => `CAST(${qi(c.name)} AS text) AS c${i}`)
            .join(', ')} FROM ${qi(source)}.${qi(t.name)}`,
        );
        for (;;) {
          const batch = asRows(
            await tx.query(`FETCH FORWARD ${FETCH_ROWS} FROM ${cursor}`),
          );
          if (!batch.length) break;
          put({
            k: 'rows',
            name: t.name,
            rows: batch.map((r) =>
              t.columns.map((_, i) =>
                r[`c${i}`] == null ? null : String(r[`c${i}`]),
              ),
            ),
          });
        }
        await tx.query(`CLOSE ${cursor}`);
      }
      for (const sql of plan.after) put({ k: 'sql', phase: 'after', sql });
      return version;
    });
    ok = true;
    return { version };
  } finally {
    closeSync(fd);
    if (!ok) rmSync(file, { force: true });
  }
}

/** The lines of a dump, one at a time (a dump can be large; it is never read whole). */
function* readLines(file: string): Generator<string> {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let pending = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      for (
        let at = pending.indexOf(0x0a);
        at >= 0;
        at = pending.indexOf(0x0a)
      ) {
        yield pending.subarray(0, at).toString('utf8');
        pending = pending.subarray(at + 1);
      }
    }
    if (pending.length) yield pending.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** What a dump says about itself, without restoring it. */
export function readDumpHeader(file: string): DumpHeader {
  if (!existsSync(file))
    throw new EngineError(`${file} does not exist`, 'not_found');
  for (const line of readLines(file)) {
    const h = JSON.parse(line) as DumpLine;
    if (h.k !== 'header' || h.format !== DUMP_FORMAT)
      throw new EngineError(
        `${file} is not a dump this engine can read`,
        'refused',
      );
    return h;
  }
  throw new EngineError(`${file} is empty`, 'refused');
}

/**
 * Build the dump in `file` as the new schema `target`, in one transaction (a
 * failure leaves no `target`). The caller swaps it in. Rows come back through
 * a cast to each column's own type, so the values are the ones dumped.
 */
export async function restoreDump(
  db: SqlDatabase,
  file: string,
  target: string,
  owner?: string,
): Promise<DumpHeader> {
  assertSchemaName(target);
  const header = readDumpHeader(file);
  await db.transaction(async (tx: SqlRunner) => {
    if (await schemaExists(tx, target))
      throw new EngineError(`schema ${target} already exists`, 'refused');
    await readAllRows(tx);
    await tx.query(
      `SELECT set_config('search_path', ${lit(qi(target))}, true)`,
    );
    let table: Extract<DumpLine, { k: 'table' }> | null = null;
    let first = true;
    for (const line of readLines(file)) {
      if (first) {
        first = false;
        continue;
      }
      const l = JSON.parse(line) as DumpLine;
      if (l.k === 'sql') await tx.query(render(l.sql, target));
      else if (l.k === 'table') {
        for (const c of l.columns) assertColumnType(c.type);
        table = l;
      } else if (l.k === 'rows') {
        if (!table || table.name !== l.name)
          throw new EngineError(
            `${file} is damaged (rows out of place)`,
            'refused',
          );
        const cols = table.columns;
        const per = Math.max(
          1,
          Math.min(ROWS_PER_INSERT, Math.floor(30000 / cols.length)),
        );
        for (let i = 0; i < l.rows.length; i += per) {
          const chunk = l.rows.slice(i, i + per);
          const params: unknown[] = [];
          const values = chunk
            .map(
              (row) =>
                `(${row
                  .map((v, c) => {
                    params.push(v);
                    return `CAST(? AS ${cols[c].type})`;
                  })
                  .join(', ')})`,
            )
            .join(', ');
          await tx.query(
            `INSERT INTO ${qi(target)}.${qi(table.name)} (${columnList(cols)})${table.overriding ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES ${values}`,
            params,
          );
        }
      }
    }
    if (owner) await claim(tx, target, owner);
  });
  return header;
}
