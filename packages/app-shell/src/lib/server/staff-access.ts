// What a STAFF member sees of the app (#5197): only the models they may read,
// described without methods, code or builder detail. The owner's
// `/api/shell/describe` stays owner-only; the layout and the `m/[model]` pages
// use this for staff instead. Every number here comes from the engine
// principal `staffPrincipalFor` builds, the same slugs `authorize.ts` checks.
import {
  type AppDefinition,
  type EnginePrincipal,
  tableFor,
} from '../../engine/index.ts';
import type { Description, ModelInfo } from '../ui/types.ts';
import type { ShellEvent } from './events.ts';
import { hostFor } from './host.ts';
import { type Principal, staffPrincipalFor, staffRoleOf } from './owner.ts';

/** The models whose records `p` may list (read access), in definition order. */
export function readableModels(
  def: AppDefinition,
  p: EnginePrincipal,
): string[] {
  const held = new Set(p.permissions);
  return Object.entries(def.models)
    .filter(([m, md]) => held.has(`${tableFor(m, md)}.list`))
    .map(([m]) => m);
}

/** Which of read, create and update `p` holds on `model` (delete is never granted). */
export function accessOf(
  def: AppDefinition,
  p: EnginePrincipal,
  model: string,
): { read: boolean; create: boolean; update: boolean } {
  const held = new Set(p.permissions);
  const table = tableFor(model, def.models[model]);
  return {
    read: held.has(`${table}.list`),
    create: held.has(`${table}.create`),
    update: held.has(`${table}.update`),
  };
}

/**
 * The live app as one staff member may see it: granted models only, with their
 * visible fields; no methods, no calculation expressions, no recipes, no draft,
 * no approvals and only the reports whose models are all readable (by name and
 * label). An app with no grants describes as an app with no models.
 */
export async function staffDescription(
  staff: Principal,
): Promise<Description & { staff: true }> {
  const host = await hostFor('live');
  const p = await staffPrincipalFor(staff, staff.tenantId, host.def);
  const readable = new Set(readableModels(host.def, p));
  const full = host.describe();
  const models: Record<string, ModelInfo> = {};
  for (const [name, info] of Object.entries(full.models)) {
    if (!readable.has(name)) continue;
    const fields = Object.fromEntries(
      Object.entries(info.fields).map(([f, def]) => [
        f,
        // A marker, never the expression: staff only need to know it is read-only.
        def.calculated !== undefined
          ? { ...def, calculated: {} as never }
          : { ...def },
      ]),
    );
    models[name] = {
      kind: 'app',
      label: info.label,
      table: info.table,
      className: info.className,
      extends: null,
      fields,
      ownFields: info.ownFields,
      methods: {},
    };
  }
  const reports: NonNullable<Description['reports']> = {};
  for (const [name, report] of Object.entries(full.reports ?? {})) {
    const source = (report.spec as { source?: unknown }).source;
    if (typeof source !== 'string' || !readable.has(source)) continue;
    const refs = Object.values(host.def.models[source]?.fields ?? {})
      .map((f) => f.ref)
      .filter((r): r is string => typeof r === 'string');
    if (!refs.every((r) => readable.has(r))) continue;
    reports[name] = {
      ...(report.label ? { label: report.label } : {}),
      ...(report.description ? { description: report.description } : {}),
      spec: { version: 1, title: report.label ?? name, source } as never,
    };
  }
  return {
    staff: true,
    mode: 'live',
    draft: null,
    frozen: false,
    name: full.name,
    version: full.version,
    recipes: [],
    models,
    reports,
    pendingApprovals: 0,
  };
}

/**
 * Whether a live event may reach this staff member's stream (#5197). Checked
 * per event against the grants as they are NOW: `records` events of a model
 * they may read (a record change of unknown model only when they may read
 * something); everything else (`changed`, `approval`, `draft`, `changes`) is
 * dropped. `close` when they are no longer ACTIVE staff, so a revoked member's
 * stream ends. Any failure drops the event (fail closed).
 */
export async function staffEventVerdict(
  staff: Principal,
  event: ShellEvent,
): Promise<'send' | 'drop' | 'close'> {
  try {
    if ((await staffRoleOf(staff)) === null) return 'close';
    if (event.type !== 'records' || event.target !== 'live') return 'drop';
    const host = await hostFor('live');
    const readable = readableModels(
      host.def,
      await staffPrincipalFor(staff, staff.tenantId, host.def),
    );
    if (event.model === null) return readable.length ? 'send' : 'drop';
    return readable.includes(event.model) ? 'send' : 'drop';
  } catch {
    return 'drop';
  }
}

/** Whether the member is still ACTIVE staff (the stream's heartbeat check). */
export async function stillStaff(staff: Principal): Promise<boolean> {
  return (await staffRoleOf(staff)) !== null;
}
