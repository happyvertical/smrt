// What staff may do with which model (#5197), kept apart from the object and
// from owner.ts so both can import it.
//
// The vocabulary is three actions, one mapping to engine slugs, used by staff
// principals now and by guests later: `read` -> list, get, count; `create`;
// `update`. `delete` and a model's method slugs are never grantable.
//
// A grant names the model and a stamp of its identity (name, table, the shipped
// model it extends). The stamp is a second lock: the first is that every grant
// of a model is deleted when the model leaves the definition (`clearGrants`,
// called from `ShellVersionStore.point`, the one place every publish, undo,
// undo-to and import moves the current definition), so a new model of an old
// name starts closed.
import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type AppDefinition,
  EngineError,
  tableFor,
} from '../../engine/index.ts';

export const ACCESS_ACTIONS = ['read', 'create', 'update'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** The engine slug actions (the part after `<table>.`) each access action stands for. */
export const ACTION_SLUG_ACTIONS: Record<AccessAction, readonly string[]> = {
  read: ['list', 'get', 'count'],
  create: ['create'],
  update: ['update'],
};

export function isAccessAction(v: unknown): v is AccessAction {
  return (
    typeof v === 'string' && (ACCESS_ACTIONS as readonly string[]).includes(v)
  );
}

/** The action, or a refusal saying why it cannot be granted. */
export function assertGrantable(action: string): AccessAction {
  if (isAccessAction(action)) return action;
  if (action === 'delete')
    throw new EngineError(
      'delete cannot be granted to staff: deleting a record waits for the owner',
      'refused',
    );
  throw new EngineError(
    `'${String(action).slice(0, 64)}' cannot be granted; staff access is read, create or update`,
    'refused',
  );
}

/** The slugs of the model's table that `actions` allow. */
export function slugsFor(
  def: AppDefinition,
  model: string,
  actions: Iterable<AccessAction>,
): string[] {
  const md = def.models[model];
  if (!md) return [];
  const table = tableFor(model, md);
  const out = new Set<string>();
  for (const a of actions)
    for (const s of ACTION_SLUG_ACTIONS[a]) out.add(`${table}.${s}`);
  return [...out];
}

/** A short stable identity of a model: name, table and the shipped model it extends. */
export function modelStamp(def: AppDefinition, model: string): string {
  const md = def.models[model];
  return createHash('sha256')
    .update(`${model}\0${md ? tableFor(model, md) : ''}\0${md?.extends ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** The one row id of a tenant + model + action: a second insert is a key clash. */
export function accessGrantId(
  tenantId: string,
  model: string,
  action: string,
): string {
  const h = createHash('sha256')
    .update(`smrt-model-access\0${tenantId}\0${model}\0${action}`)
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function modelsOf(json: string): Set<string> | null {
  try {
    const def = JSON.parse(json) as { models?: Record<string, unknown> };
    return new Set(Object.keys(def.models ?? {}));
  } catch {
    return null;
  }
}

/**
 * Delete the grants of every model that was in `previous` and is not in `next`
 * (a removal, an undo or undo-to past a model's creation); of every model when
 * there was none before (an import into an empty app) or either definition
 * cannot be read (fail closed). Raw SQL, so the tenant is named here; a store
 * with no tenant (the desktop's one owner) clears all rows.
 */
export async function clearGrants(
  db: Pick<DatabaseInterface, 'query'>,
  tenantId: string | null,
  previous: string,
  next: string,
): Promise<void> {
  const before = modelsOf(previous);
  const after = modelsOf(next);
  const tenant = tenantId ? ' AND tenant_id = ?' : '';
  const params = tenantId ? [tenantId] : [];
  if (!before || !after || before.size === 0) {
    await db.query(
      `DELETE FROM model_access_grants WHERE 1 = 1${tenant}`,
      params,
    );
    return;
  }
  for (const model of before)
    if (!after.has(model))
      await db.query(
        `DELETE FROM model_access_grants WHERE model_name = ?${tenant}`,
        [model, ...params],
      );
}
