import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { EngineError } from '../../engine/index.ts';
import { getShellDb } from '../server/host.ts';
import {
  ACCESS_ACTIONS,
  type AccessAction,
  accessGrantId,
  assertGrantable,
  sharedTableModels,
} from '../server/model-access.ts';
import { assertOwner } from '../server/owner.ts';
import { ShellVersionStore } from '../server/version-store.ts';

/**
 * One thing the tenant's staff may do with one model of the user app (#5197):
 * `read`, `create` or `update`, as a group (not per person). No row means
 * closed. Keyed by tenant + model name + action (one row each, by a derived
 * id), and stamped with the model's identity so a model of the same name made
 * later does not inherit it; rows are also deleted when the model is removed
 * (`ShellVersionStore.point`, see model-access.ts). `delete` and method slugs
 * are never grantable.
 *
 * No generated surface: only the owner-only statics below write rows (they
 * start with `assertOwner()`); `staffPrincipalFor` reads them.
 */
@smrt({
  tableName: 'model_access_grants',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
  tenantScoped: { mode: 'optional' },
})
export class ModelAccessGrant extends SmrtObject {
  /** The tenant column the tenancy layer owns (typing only: no field of its own). */
  declare tenantId?: string | null;

  /** The model's name in the user app definition. */
  @field({ type: 'text', required: true, requiredFor: 'identity' })
  modelName: string = '';

  /** `modelStamp(def, modelName)` when granted; a grant whose stamp differs is ignored. */
  @field({ type: 'text', required: true, requiredFor: 'identity' })
  modelStamp: string = '';

  /** `read`, `create` or `update` (no CHECK: the code is the rule). */
  @field({ type: 'text', required: true, requiredFor: 'identity' })
  action: string = '';

  /** The owner who granted it. */
  @field({ type: 'text' })
  grantedBy: string = '';

  /**
   * Owner only: allow staff `action` on `model` of the STORED current
   * definition (read here, never taken from the caller). Idempotent. A model
   * whose table another model shares is refused (slugs are per table).
   */
  static async grant(
    model: string,
    action: string,
  ): Promise<{ model: string; action: AccessAction }> {
    const owner = await assertOwner();
    const act = assertGrantable(action);
    const db = await getShellDb();
    const { def, stamps } = await new ShellVersionStore(
      db,
      owner.tenantId,
    ).modelStamps();
    const stamp = stamps.get(model);
    if (!def || !stamp || !Object.hasOwn(def.models, model))
      throw new Error(`there is no model '${model}'`);
    if (sharedTableModels(def).has(model))
      throw new EngineError(
        `'${model}' shares its table with another model, so it cannot be granted`,
        'refused',
      );
    const grants = await ModelAccessGrantCollection.create({ db });
    const id = accessGrantId(owner.tenantId, model, act);
    const write = async (): Promise<boolean> => {
      const [row] = await grants.list({ where: { id }, limit: 1 });
      if (!row) return false;
      row.modelStamp = stamp;
      row.grantedBy = owner.id;
      await row.save();
      return true;
    };
    if (!(await write())) {
      try {
        const row = await grants.create({
          id,
          tenantId: owner.tenantId,
          modelName: model,
          modelStamp: stamp,
          action: act,
          grantedBy: owner.id,
        });
        await row.save();
      } catch (error) {
        // Lost the insert to an overlapping grant of the same key: update it.
        if (!(await write())) throw error;
      }
    }
    return { model, action: act };
  }

  /** Owner only: take `action` on `model` back from staff. True when a grant existed. */
  static async revoke(model: string, action: string): Promise<boolean> {
    const owner = await assertOwner();
    const act = assertGrantable(action);
    const grants = await ModelAccessGrantCollection.create({
      db: await getShellDb(),
    });
    const [row] = await grants.list({
      where: { id: accessGrantId(owner.tenantId, model, act) },
      limit: 1,
    });
    if (!row) return false;
    await row.delete();
    return true;
  }

  /** Owner only: every grant of the tenant. */
  static async list(): Promise<
    { model: string; action: AccessAction; grantedBy: string }[]
  > {
    const owner = await assertOwner();
    const grants = await ModelAccessGrantCollection.create({
      db: await getShellDb(),
    });
    const rows = await grants.list({ limit: 10000 });
    return rows
      .filter((r) => r.tenantId === owner.tenantId)
      .filter((r) => (ACCESS_ACTIONS as readonly string[]).includes(r.action))
      .map((r) => ({
        model: r.modelName,
        action: r.action as AccessAction,
        grantedBy: r.grantedBy,
      }));
  }
}

export class ModelAccessGrantCollection extends SmrtCollection<ModelAccessGrant> {
  static readonly _itemClass = ModelAccessGrant;
}
