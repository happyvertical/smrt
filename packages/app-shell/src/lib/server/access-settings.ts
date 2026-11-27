// The owner's view and control of staff access per model (#5197 S5). The rules
// live in `ModelAccessGrant` (read before create/update, delete never
// grantable, shared tables refused); this only lists and routes to them.
import { ModelAccessGrant } from '../objects/ModelAccessGrant.ts';
import { hostFor } from './host.ts';
import { HttpError } from './http.ts';
import { sharedTableModels } from './model-access.ts';

export interface ModelAccessRow {
  model: string;
  label: string;
  /** False when the model shares its table with another model: it stays closed. */
  grantable: boolean;
  read: boolean;
  create: boolean;
  update: boolean;
}

/** Every model of the live app with what staff may do with it now. Owner only (via the grant list). */
export async function accessOverview(): Promise<ModelAccessRow[]> {
  const grants = await ModelAccessGrant.list();
  const host = await hostFor('live');
  const shared = sharedTableModels(host.def);
  const held = new Set(grants.map((g) => `${g.model}:${g.action}`));
  return Object.entries(host.describe().models)
    .filter(([, info]) => info.kind === 'app')
    .map(([model, info]) => ({
      model,
      label: info.label,
      grantable: !shared.has(model),
      read: held.has(`${model}:read`),
      create: held.has(`${model}:create`),
      update: held.has(`${model}:update`),
    }));
}

/**
 * Allow (`allowed` true) or take back one action on one model, then return
 * the refreshed overview. Refusals are the grant methods' own `EngineError`s.
 */
export async function setAccess(
  model: string,
  action: string,
  allowed: boolean,
): Promise<ModelAccessRow[]> {
  const host = await hostFor('live');
  if (!Object.hasOwn(host.def.models, model))
    throw new HttpError(404, `This app has no "${model.slice(0, 64)}" model.`);
  if (allowed) await ModelAccessGrant.grant(model, action);
  else await ModelAccessGrant.revoke(model, action);
  return accessOverview();
}
