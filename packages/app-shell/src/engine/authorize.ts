// What a principal may ask of an app worker (#5188), decided in the worker
// before any operation runs. Core's REST server enforces sign-in and write
// slugs itself (`resolvePrincipal`), but it gates reads only on sign-in and the
// direct record, report, count and tool ops never reach it, so this module
// gates every op on the `<collection>.<action>` slug of the model it touches.
//
// - `system` (the engine's own authority) may do everything.
// - A guest is refused: the policies (#5189) gate by slug and tenant, and no
//   rule yet says what a guest may read.
// - Ops that exist for the change engine (previews, counts of values, dumps,
//   archive purges, imports) are system-only.

import type { AppDefinition } from './definition.ts';
import { routeFor } from './definition.ts';
import { PermissionDeniedError } from './errors.ts';
import { modelOfTable, slugFor, toolTarget } from './permissions.ts';
import { type EnginePrincipal, holds } from './principal.ts';
import type { WorkerOp } from './worker-protocol.ts';

const SYSTEM_ONLY = new Set<WorkerOp>([
  'previewMerge',
  'previewExtract',
  'previewLoad',
  'previewConversion',
  'previewUndo',
  'countValues',
  'countArchives',
  'countOverwrites',
  'snapshot',
  'copyTo',
  'pruneSnapshots',
  'purgeArchives',
  'importRecords',
]);

const deny = (what: string): never => {
  throw new PermissionDeniedError(`permission denied: ${what}`);
};

/**
 * Require the slug of `action` on `model`. A name the app does not have is
 * let through: the runtime refuses it as unknown (nothing to read or change),
 * and the caller learns no more than it would from the unknown-name error.
 */
function need(
  def: AppDefinition,
  p: EnginePrincipal,
  model: unknown,
  action: string,
): void {
  if (typeof model !== 'string') deny('a model is needed');
  if (typeof model !== 'string' || !Object.hasOwn(def.models, model)) return;
  const md = def.models[model];
  const known =
    ['list', 'get', 'create', 'update', 'delete'].includes(action) ||
    Object.hasOwn(md.methods ?? {}, action);
  if (known && !holds(p, slugFor(def, model, action)))
    deny(`${action} on ${model}`);
}

/** Models a report reads: its source and the models its source references. */
export function reportModels(def: AppDefinition, input: unknown): string[] {
  let spec: unknown = input;
  if (typeof input === 'string')
    spec = Object.hasOwn(def.reports ?? {}, input)
      ? def.reports?.[input]?.spec
      : undefined;
  const source = (spec as { source?: unknown } | undefined)?.source;
  if (typeof source !== 'string' || !Object.hasOwn(def.models, source))
    return [];
  const refs = Object.values(def.models[source].fields)
    .map((f) => f.ref)
    .filter((r): r is string => typeof r === 'string');
  return [source, ...refs];
}

/** The model and read/write action a REST request reaches (`null`: not one of the app's routes). */
export function restTarget(
  def: AppDefinition,
  req: { method: string; url: string },
): { model: string; action: string } | null {
  let parts: string[];
  try {
    parts = new URL(req.url, 'http://app.local').pathname
      .split('/')
      .filter(Boolean);
  } catch {
    return null;
  }
  const hit = Object.entries(def.models).find(
    ([m, md]) => routeFor(m, md) === parts[1],
  );
  if (!hit) return null;
  const read = ['GET', 'HEAD'].includes(req.method.toUpperCase());
  if (!read) return null; // writes are core's: `requirePermission`
  return {
    model: hit[0],
    action: parts.length < 3 || parts[2] === 'count' ? 'list' : 'get',
  };
}

/** Throws `PermissionDeniedError` unless `p` may run `op` with `args` on `def`. */
export function authorizeOp(
  def: AppDefinition,
  p: EnginePrincipal,
  op: WorkerOp,
  args: unknown[],
): void {
  if (p.kind === 'system') return;
  if (p.kind !== 'user') deny('guests cannot use this app');
  if (SYSTEM_ONLY.has(op)) deny(`${op} is for the engine`);
  switch (op) {
    case 'list':
    case 'listByIds':
    case 'readStoredRows':
      need(def, p, args[0], 'list');
      break;
    case 'get':
      need(def, p, args[0], 'get');
      break;
    case 'create':
      need(def, p, args[0], 'create');
      break;
    case 'update':
      need(def, p, args[0], 'update');
      break;
    case 'remove':
      need(def, p, args[0], 'delete');
      break;
    case 'runMethod':
      need(def, p, args[0], String(args[1]));
      break;
    case 'countRows':
    case 'columnInfo': {
      const model =
        typeof args[0] === 'string' ? modelOfTable(def, args[0]) : null;
      need(def, p, model, 'list');
      break;
    }
    case 'compileReport':
    case 'runReport': {
      const models = reportModels(def, args[0]);
      for (const m of models) need(def, p, m, 'list');
      break;
    }
    case 'tools':
      break; // filtered to the slugs held, in the runtime
    case 'callTool': {
      const t = typeof args[0] === 'string' ? toolTarget(def, args[0]) : null;
      if (t) need(def, p, t.model, t.action); // unknown: the runtime says so
      break;
    }
    case 'rest': {
      const r = args[0] as { method?: unknown; url?: unknown } | undefined;
      if (typeof r?.method !== 'string' || typeof r.url !== 'string')
        deny('malformed request');
      else {
        const t = restTarget(def, { method: r.method, url: r.url });
        // Writes are core's: `requirePermission` under resolvePrincipal.
        if (t) need(def, p, t.model, t.action);
      }
      break;
    }
    default:
      deny(op);
  }
}
