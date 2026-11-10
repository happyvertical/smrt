import { detectEngine } from '@happyvertical/smrt-core';
/** Explicit maintenance migration for typed email contact identities. No runtime DDL. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  assertNotificationMaintenanceHost,
  buildSqliteRebuildStatements,
} from '../host.js';

export type NotificationProfileRecipientEngine = 'postgres' | 'sqlite';
export interface NotificationProfileRecipientPlan {
  engine: NotificationProfileRecipientEngine;
  ready: boolean;
  statements: string[];
  invalidRowIds: string[];
  obsoleteIndexes: string[];
}
const table = 'notification_deliveries';
const checkName = 'notification_deliveries_recipient_identity_check';
const userIndex = 'notification_deliveries_user_identity';
const profileIndex = 'notification_deliveries_profile_identity';
const typedIndex = 'notification_deliveries_typed_identity';
const identityCheck = `(recipient_kind IS NOT NULL AND ((recipient_kind = 'user' AND recipient_user_id IS NOT NULL AND length(trim(CAST(recipient_user_id AS TEXT))) > 0 AND recipient_profile_id IS NULL AND (required_dispatch_policy IS NULL OR required_dispatch_policy NOT LIKE 'profile:%') AND kind NOT LIKE 'protected:profile:%') OR (recipient_kind = 'profile' AND recipient_user_id IS NULL AND recipient_profile_id IS NOT NULL AND length(trim(CAST(recipient_profile_id AS TEXT))) > 0 AND channel = 'email' AND required_dispatch_policy IS NOT NULL AND length(trim(required_dispatch_policy)) > 8 AND required_dispatch_policy LIKE 'profile:%' AND kind = 'protected:' || required_dispatch_policy)))`;
/** Canonical Boolean tree ignores PG's redundant parentheses/casts, preserving AND/OR precedence. */
function canonicalCheck(sql: string): string {
  const value = sql
    .trim()
    .replace(/^CHECK\s*/i, '')
    .replace(/::text\b/gi, '')
    .replace(/!~~/g, ' NOT LIKE ')
    .replace(/~~/g, ' LIKE ')
    .replace(/CAST\(\s*([a-z_]+)\s+AS\s+TEXT\s*\)/gi, '$1')
    .replace(/TRIM\(\s*BOTH\s+FROM\s+/gi, 'trim(');
  function outer(text: string): string {
    text = text.trim();
    while (text.startsWith('(') && text.endsWith(')')) {
      let depth = 0,
        quoted = false,
        complete = true;
      for (let i = 0; i < text.length - 1; i++) {
        if (text[i] === "'") quoted = !quoted;
        if (quoted) continue;
        if (text[i] === '(') depth++;
        if (text[i] === ')' && --depth === 0) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
      text = text.slice(1, -1).trim();
    }
    return text;
  }
  function parse(text: string): unknown {
    text = outer(text);
    for (const op of ['OR', 'AND']) {
      let depth = 0,
        quoted = false,
        start = 0;
      const terms: string[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "'") quoted = !quoted;
        if (quoted) continue;
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
        if (
          !depth &&
          text.slice(i).match(new RegExp('^' + op + '\\b', 'i')) &&
          (i === 0 || /\s/.test(text[i - 1]))
        ) {
          terms.push(text.slice(start, i));
          start = i + op.length;
          i += op.length - 1;
        }
      }
      if (terms.length)
        return [op, ...[...terms, text.slice(start)].map(parse)];
    }
    return text.toLowerCase().replace(/[\s()"]/g, '');
  }
  return JSON.stringify(parse(value));
}
const quote = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name))
    throw new Error('Unsafe notification schema identifier.');
  return `"${name}"`;
};
function indexColumns(sql: string): string[] {
  const match = /\(([^()]+)\)\s*(?:NULLS\s+NOT\s+DISTINCT)?\s*$/i.exec(sql);
  return match
    ? match[1].split(',').map((s) => s.trim().replaceAll('"', ''))
    : [];
}
function same(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
const userColumns = ['tenant_id', 'recipient_user_id', 'channel', 'source_ref'];
const profileColumns = [
  'tenant_id',
  'recipient_profile_id',
  'channel',
  'source_ref',
];
const typedColumns = [
  'tenant_id',
  'recipient_kind',
  'recipient_user_id',
  'recipient_profile_id',
  'channel',
  'source_ref',
];
async function inspect(
  db: Pick<DatabaseInterface, 'query'>,
  engine: NotificationProfileRecipientEngine,
) {
  if (engine !== 'sqlite' && engine !== 'postgres')
    throw new Error(
      'Profile recipients require SQLite or PostgreSQL maintenance.',
    );
  const columns =
    engine === 'sqlite'
      ? ((await db.query(`PRAGMA table_info(${quote(table)})`)).rows as {
          name: string;
          notnull: number;
        }[])
      : ((
          await db.query(
            "SELECT column_name AS name, CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?",
            table,
          )
        ).rows as { name: string; notnull: number }[]);
  if (!columns.length)
    throw new Error(
      'Migrate the notification outbox table before profile recipient maintenance.',
    );
  const indexes =
    engine === 'sqlite'
      ? ((
          await db.query(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
            table,
          )
        ).rows as { name: string; sql: string }[])
      : ((
          await db.query(
            'SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE schemaname=current_schema() AND tablename=?',
            table,
          )
        ).rows as { name: string; sql: string }[]);
  const ddl =
    engine === 'sqlite'
      ? String(
          (
            await db.query(
              "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
              table,
            )
          ).rows[0]?.sql ?? '',
        )
      : String(
          (
            await db.query(
              'SELECT pg_get_constraintdef(oid) AS sql FROM pg_constraint WHERE conrelid=?::regclass AND conname=?',
              table,
              checkName,
            )
          ).rows[0]?.sql ?? '',
        );
  const obsolete = indexes.filter(
    (i) =>
      /NULLS\s+NOT\s+DISTINCT/i.test(i.sql) &&
      same(indexColumns(i.sql), userColumns),
  );
  const validIndex = (name: string, expected: string[]) =>
    indexes.some(
      (i) =>
        i.name === name &&
        /CREATE\s+UNIQUE\s+INDEX/i.test(i.sql) &&
        same(indexColumns(i.sql), expected) &&
        !(/NULLS\s+NOT\s+DISTINCT/i.test(i.sql) && name !== typedIndex),
    );
  const hasColumns = ['recipient_kind', 'recipient_profile_id'].every((name) =>
    columns.some((c) => c.name === name),
  );
  const hasCheck =
    engine === 'sqlite'
      ? ddl.includes(checkName) && ddl.includes(identityCheck)
      : !ddl.includes('NOT VALID') &&
        canonicalCheck(ddl) === canonicalCheck(identityCheck);
  const ready =
    hasColumns &&
    !Number(columns.find((c) => c.name === 'recipient_user_id')?.notnull) &&
    hasCheck &&
    !obsolete.length &&
    validIndex(userIndex, userColumns) &&
    validIndex(profileIndex, profileColumns) &&
    validIndex(typedIndex, typedColumns);
  return {
    columns,
    indexes,
    ddl,
    obsolete,
    ready,
    hasColumns,
    hasCheck,
    validIndex,
  };
}
/** Read-only plan against the live schema. Refuses ambiguous drift and never changes rows. */
export async function planNotificationProfileRecipients(
  db: Pick<DatabaseInterface, 'query'>,
  engine: NotificationProfileRecipientEngine,
): Promise<NotificationProfileRecipientPlan> {
  assertNotificationMaintenanceHost();
  const state = await inspect(db, engine);
  const result: NotificationProfileRecipientPlan = {
    engine,
    ready: state.ready,
    statements: [],
    invalidRowIds: [],
    obsoleteIndexes: state.obsolete.map((i) => i.name),
  };
  if (state.ready) return result;
  const kind = state.columns.some((c) => c.name === 'recipient_kind')
    ? 'recipient_kind'
    : "'user'";
  const profile = state.columns.some((c) => c.name === 'recipient_profile_id')
    ? 'recipient_profile_id'
    : 'NULL';
  const rows = (
    await db.query(
      `SELECT id, tenant_id, recipient_user_id, ${kind} AS recipient_kind, ${profile} AS recipient_profile_id, channel, source_ref, kind, required_dispatch_policy FROM ${quote(table)}`,
    )
  ).rows;
  const identities = new Set<string>();
  for (const row of rows) {
    const user =
      row.recipient_kind === 'user' &&
      row.recipient_user_id != null &&
      String(row.recipient_user_id).trim() !== '' &&
      row.recipient_profile_id == null;
    const contact =
      row.recipient_kind === 'profile' &&
      row.recipient_user_id == null &&
      row.recipient_profile_id != null &&
      String(row.recipient_profile_id).trim() !== '' &&
      row.channel === 'email' &&
      typeof row.required_dispatch_policy === 'string' &&
      Boolean(row.required_dispatch_policy.trim()) &&
      row.kind === `protected:${row.required_dispatch_policy}`;
    const key = JSON.stringify([
      row.tenant_id,
      row.recipient_kind,
      row.recipient_user_id,
      row.recipient_profile_id,
      row.channel,
      row.source_ref,
    ]);
    if (!(user || contact) || identities.has(key))
      result.invalidRowIds.push(String(row.id));
    identities.add(key);
  }
  if (result.invalidRowIds.length) return result;
  for (const [name, columns] of [
    [userIndex, userColumns],
    [profileIndex, profileColumns],
    [typedIndex, typedColumns],
  ] as const) {
    const found = state.indexes.find((i) => i.name === name);
    if (found && !state.validIndex(name, [...columns]))
      throw new Error(`Unexpected notification index drift: ${name}`);
  }
  if (engine === 'postgres') {
    if (!state.columns.some((c) => c.name === 'recipient_kind'))
      result.statements.push(
        `ALTER TABLE ${quote(table)} ADD COLUMN recipient_kind TEXT NOT NULL DEFAULT 'user'`,
      );
    if (!state.columns.some((c) => c.name === 'recipient_profile_id'))
      result.statements.push(
        `ALTER TABLE ${quote(table)} ADD COLUMN recipient_profile_id UUID REFERENCES profiles(id)`,
      );
    result.statements.push(
      `ALTER TABLE ${quote(table)} ALTER COLUMN recipient_user_id DROP NOT NULL`,
    );
    if (!state.hasCheck) {
      if (state.ddl)
        throw new Error('Unexpected notification identity CHECK drift.');
      result.statements.push(
        `ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(checkName)} CHECK ${identityCheck}`,
      );
    }
    for (const index of state.obsolete)
      result.statements.push(`DROP INDEX ${quote(index.name)}`);
  } else if (
    !state.hasColumns ||
    Number(
      state.columns.find((c) => c.name === 'recipient_user_id')?.notnull,
    ) ||
    !state.hasCheck
  ) {
    // The core planner owns live-DDL preservation and rowid/index/trigger copying.
    const incoming = (
      await db.query(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>?",
        table,
      )
    ).rows;
    for (const row of incoming) {
      const refs = (
        await db.query(`PRAGMA foreign_key_list(${quote(String(row.name))})`)
      ).rows;
      if (refs.some((r) => r.table === table))
        throw new Error(
          'SQLite profile maintenance requires an explicit inbound-FK-safe migration window.',
        );
    }
    if (!/\)\s*;?\s*$/.test(state.ddl))
      throw new Error('Unsupported SQLite notification table shape.');
    if (state.ddl.includes(checkName) && !state.hasCheck)
      throw new Error('Unexpected notification identity CHECK drift.');
    const ddl = state.hasCheck
      ? state.ddl
      : state.ddl.replace(
          /\)\s*;?\s*$/,
          `, CONSTRAINT ${quote(checkName)} CHECK ${identityCheck})`,
        );
    const triggers = (
      await db.query(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
        table,
      )
    ).rows as { name: string; sql: string }[];
    const plan = buildSqliteRebuildStatements({
      tableName: table,
      createTableSql: ddl,
      columnTypes: new Map(),
      columns: state.columns.map((c) => c.name),
      objects: [...state.indexes, ...triggers],
      legacyAlterTable: Boolean(
        (await db.query('PRAGMA legacy_alter_table')).rows[0]
          ?.legacy_alter_table,
      ),
      nullableColumns: new Set(
        Number(
          state.columns.find((c) => c.name === 'recipient_user_id')?.notnull,
        )
          ? ['recipient_user_id']
          : [],
      ),
      appendColumns: [
        ...(!state.columns.some((c) => c.name === 'recipient_kind')
          ? [
              {
                name: 'recipient_kind',
                definition: "recipient_kind TEXT NOT NULL DEFAULT 'user'",
                copyExpression: "'user'",
              },
            ]
          : []),
        ...(!state.columns.some((c) => c.name === 'recipient_profile_id')
          ? [
              {
                name: 'recipient_profile_id',
                definition: 'recipient_profile_id UUID REFERENCES profiles(id)',
                copyExpression: 'NULL',
              },
            ]
          : []),
      ],
    });
    if (!plan)
      throw new Error(
        'SQLite profile identity rebuild requires manual schema reconciliation.',
      );
    if (plan.statements.some((s) => /PRAGMA foreign_keys\s*=\s*OFF/i.test(s)))
      throw new Error(
        'SQLite profile maintenance cannot disable foreign keys.',
      );
    result.statements.push(...plan.statements);
  }
  for (const [name, columns] of [
    [userIndex, userColumns],
    [profileIndex, profileColumns],
    [typedIndex, typedColumns],
  ] as const)
    if (!state.validIndex(name, [...columns]))
      result.statements.push(
        `CREATE UNIQUE INDEX ${quote(name)} ON ${quote(table)} (${columns.map(quote).join(', ')})${engine === 'postgres' && name === typedIndex ? ' NULLS NOT DISTINCT' : ''}`,
      );
  return result;
}
/** Apply/replay atomically using a root maintenance handle. No row IDs or evidence are rewritten. */
export async function migrateNotificationProfileRecipients(
  db: DatabaseInterface,
  engine: NotificationProfileRecipientEngine,
): Promise<NotificationProfileRecipientPlan> {
  assertNotificationMaintenanceHost();
  if (!db.transaction)
    throw new Error('Notification profile migration requires transactions.');
  let result: NotificationProfileRecipientPlan | undefined;
  await db.transaction(async (tx) => {
    if (engine === 'postgres')
      await tx.query(`LOCK TABLE ${quote(table)} IN ACCESS EXCLUSIVE MODE`);
    const plan = await planNotificationProfileRecipients(tx, engine);
    if (plan.invalidRowIds.length)
      throw new Error(
        `Invalid notification recipient rows: ${plan.invalidRowIds.join(', ')}`,
      );
    for (const statement of plan.statements) await tx.query(statement);
    const verified = await planNotificationProfileRecipients(tx, engine);
    if (!verified.ready)
      throw new Error(
        'Notification profile schema did not reach verified constraints.',
      );
    result = plan;
  });
  if (!result)
    throw new Error(
      'Notification profile migration transaction did not execute.',
    );
  return result;
}
/** Profile-only runtime admission gate checks physical constraints/indexes, never a migration marker. */
export async function assertNotificationProfileRecipientSchema(
  db: Pick<DatabaseInterface, 'query' | 'url'>,
): Promise<void> {
  const hint: unknown = Reflect.get(db, 'type');
  const engine = detectEngine(
    db.url,
    typeof hint === 'string' ? hint : undefined,
  );
  if (engine !== 'sqlite' && engine !== 'postgres')
    throw new Error(
      'Profile recipients require explicit supported schema maintenance.',
    );
  if (!(await inspect(db, engine)).ready)
    throw new Error('Profile recipient schema maintenance is required.');
}
