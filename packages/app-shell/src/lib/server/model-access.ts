// What staff may do with which model (#5197), kept apart from the object and
// from owner.ts so both can import it.
//
// The vocabulary is three actions, one mapping to engine slugs, used by staff
// principals now and by guests later: `read` -> list, get, count; `create`;
// `update`. `delete` and a model's method slugs are never grantable.
//
// A grant names the model and a stamp of its creation identity: the number of
// the version that created it in the chain leading to the current version
// (`creationStamps`), so a model removed and defined again, in any later or the
// same publish, never matches an old grant. The stamp is the second lock; the
// first is that every grant of a model is deleted when the model leaves the
// definition (`clearGrantsAcross`, called from `ShellVersionStore.point`, the
// one place every publish, undo, undo-to and import moves the current
// definition). A template import only runs on an empty app (engine
// `analyseImport`), also when it is published from a draft, so it always starts
// from a definition with no models and clears every grant of the tenant.
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

/**
 * Models whose table is also another model's (`Chore` and `Chores` both map to
 * `u_chores`). Slugs are per table, so a grant on one would open the other:
 * such models are never grantable and never given slugs.
 */
export function sharedTableModels(def: AppDefinition): Set<string> {
  const byTable = new Map<string, string[]>();
  for (const [m, md] of Object.entries(def.models)) {
    const t = tableFor(m, md);
    byTable.set(t, [...(byTable.get(t) ?? []), m]);
  }
  const out = new Set<string>();
  for (const names of byTable.values())
    if (names.length > 1) for (const n of names) out.add(n);
  return out;
}

/**
 * The last filter before a staff principal is built: only `<table>.<action>`
 * slugs of the fixed action map for models of `def` (never `_engine.owner`,
 * delete or a method slug, whatever came before).
 */
export function finalStaffSlugs(
  def: AppDefinition,
  slugs: Iterable<string>,
): string[] {
  const allowed = new Set<string>();
  const shared = sharedTableModels(def);
  for (const [m, md] of Object.entries(def.models)) {
    if (shared.has(m)) continue;
    for (const list of Object.values(ACTION_SLUG_ACTIONS))
      for (const a of list) allowed.add(`${tableFor(m, md)}.${a}`);
  }
  return [...new Set(slugs)].filter(
    (s) => s !== '_engine.owner' && allowed.has(s),
  );
}

/**
 * Per-model creation identities from the version chain: a model's stamp is the
 * number of the version that created it in the chain leading to `current`
 * (parent links; an undone branch is not in it). Removing and adding a model
 * of the same name makes a later version, so the stamp differs.
 */
export function creationStamps(
  versions: {
    version: number;
    parent: number | null;
    definition: AppDefinition;
  }[],
  current: number,
): Map<string, string> {
  const byNumber = new Map(versions.map((v) => [v.version, v]));
  const chain: typeof versions = [];
  for (
    let v = byNumber.get(current);
    v && chain.length <= versions.length;
    v = v.parent === null ? undefined : byNumber.get(v.parent)
  )
    chain.unshift(v);
  const stamps = new Map<string, string>();
  let present = new Set<string>();
  for (const v of chain) {
    const now = new Set(Object.keys(v.definition.models ?? {}));
    for (const m of now) if (!present.has(m)) stamps.set(m, String(v.version));
    for (const m of present) if (!now.has(m)) stamps.delete(m);
    present = now;
  }
  return stamps;
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
  all = false,
): Promise<void> {
  const before = modelsOf(previous);
  const after = modelsOf(next);
  const tenant = tenantId ? ' AND tenant_id = ?' : '';
  const params = tenantId ? [tenantId] : [];
  if (all || !before || !after || before.size === 0) {
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

/**
 * `clearGrants` over every transition of one publish: the old definition, each
 * version the batch appended in order, then the one made current. A model
 * removed and defined again inside one batch loses its grants (its new stamp
 * would not match them anyway).
 */
export async function clearGrantsAcross(
  db: Pick<DatabaseInterface, 'query'>,
  tenantId: string | null,
  previous: string,
  steps: string[],
  all = false,
): Promise<void> {
  let before = previous;
  for (const next of steps) {
    await clearGrants(db, tenantId, before, next, all);
    before = next;
  }
}
