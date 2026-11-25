// The method-code entitlement gate (#5194, decision on #5597). App-authored
// method code runs in a QuickJS sandbox inside the host process, so a hosted
// deployment runs it only for a tenant whose entitlement grants it. Without
// the entitlement the engine refuses to RUN method code and refuses to ADD or
// CHANGE it; code already stored stays in the definition, inert. Formulas are
// expression trees the database evaluates and never need the entitlement.
//
// The decision is made on the host (never in the worker), per call, so a
// change of plan applies at once. No gate injected (the desktop, any other
// profile, every test that does not choose) means no check and no lookup.
import type { AppDefinition } from './definition.ts';
import { CRUD_ACTIONS, routeFor } from './definition.ts';
import { toolTarget } from './permissions.ts';

/**
 * Whether `tenantId` may run app-authored method code. Called by the host with
 * its own tenant, never one a caller named. A throw is a failed check, which
 * the engine treats as a refusal, never as "yes".
 */
export type MethodCodeGate = (tenantId: string) => boolean | Promise<boolean>;

/** `EngineError.details.code` of a method-code refusal; routes keep it. */
export const METHOD_CODE_DENIED = 'method_code_not_enabled';

/** The owner-facing message of a refusal; `what` names the method or the change. */
export function methodCodeMessage(what: string): string {
  return `${what}: custom method code is not enabled for this workspace, so it was not run or saved. Your records, reports and formulas keep working. Method code runs in the desktop app on your own machine.`;
}

/** A method of the app that carries code and that an op would run. */
export interface MethodTarget {
  model: string;
  method: string;
}

const hasCode = (def: AppDefinition, model: string, method: string) =>
  Object.hasOwn(def.models, model) &&
  Object.hasOwn(def.models[model].methods ?? {}, method) &&
  typeof def.models[model].methods?.[method]?.code === 'string';

/**
 * The method an op would run, or null when it cannot run method code. The
 * three worker ops that end in the sandbox are `runMethod`, the app's own
 * method tools (`callTool`) and a REST request whose last segment names a
 * method. Every other op reaches `runMethod` only through a method installed on
 * the model prototype; `AppRuntime.register` never installs one that shadows a
 * framework member (`initialize`, `validateBeforeSave`, ...), so none does.
 */
export function methodCodeTarget(
  def: AppDefinition,
  op: string,
  args: unknown[],
): MethodTarget | null {
  if (op === 'runMethod') {
    const [model, method] = args;
    return typeof model === 'string' &&
      typeof method === 'string' &&
      hasCode(def, model, method)
      ? { model, method }
      : null;
  }
  if (op === 'callTool') {
    const t = typeof args[0] === 'string' ? toolTarget(def, args[0]) : null;
    // `<model>_list` is the CRUD list even when a stored method has that name.
    return t &&
      !CRUD_ACTIONS.includes(t.action) &&
      hasCode(def, t.model, t.action)
      ? { model: t.model, method: t.action }
      : null;
  }
  if (op === 'rest') {
    const req = args[0] as { url?: unknown } | undefined;
    if (typeof req?.url !== 'string') return null;
    let parts: string[];
    try {
      parts = new URL(req.url, 'http://app.local').pathname
        .split('/')
        .filter(Boolean);
    } catch {
      return null;
    }
    // `/api/<route>/<idOrAction>`: the routed model, and only its own method
    // named in the action position (never the route segment itself).
    const hit = Object.entries(def.models).find(
      ([m, md]) => routeFor(m, md) === parts[1],
    );
    const action = parts[2];
    if (
      hit &&
      action !== undefined &&
      !CRUD_ACTIONS.includes(action) &&
      hasCode(def, hit[0], action)
    )
      return { model: hit[0], method: action };
  }
  return null;
}

/** Methods of `to` that are new or changed against `from`: the code a change introduces. */
export function introducedCode(
  from: AppDefinition,
  to: AppDefinition,
): string[] {
  const out: string[] = [];
  for (const [model, md] of Object.entries(to.models))
    for (const [name, meth] of Object.entries(md.methods ?? {})) {
      const before = from.models[model]?.methods?.[name];
      if (!before || before.code !== meth.code) out.push(`${model}.${name}()`);
    }
  return out;
}
