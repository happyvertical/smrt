/**
 * #5143: the run-time coexistence set is part of the subtype lineage a
 * registration checkpoint saves, by value, and a rollback restores.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import { registerRuntimeModel } from '../../runtime-model.js';
import { snapshotObjectRegistryState } from '../../test-utils';
import {
  checkpointSubtypeLineage,
  clearSubtypeLineage,
  runtimeCoexistingModels,
} from '../subtype-lineage';

const BASE = '@fixture/rollback-video:Scene';
const RUNTIME = '@fixture/rollback-app:Scene';

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('runtime coexistence membership and rollback', () => {
  it('restores the saved membership by value after the live set is cleared and mutated', () => {
    runtimeCoexistingModels().add('@fixture/a:Kept');
    const rollback = checkpointSubtypeLineage(new Set(['@fixture/a:Kept']));
    runtimeCoexistingModels().add('@fixture/a:Intervening');
    clearSubtypeLineage();
    expect(runtimeCoexistingModels().size).toBe(0);
    rollback();
    expect([...runtimeCoexistingModels()]).toEqual(['@fixture/a:Kept']);
  });

  it('leaves no coexistence key behind when a rolled-back run-time model is undone', () => {
    class Scene extends SmrtObject {}
    ObjectRegistry.register(Scene, {
      name: 'Scene',
      packageName: '@fixture/rollback-video',
      tableName: 'scenes',
    });
    const rollback = ObjectRegistry.checkpointRegistrations([RUNTIME]);
    registerRuntimeModel({
      name: 'Scene',
      packageName: '@fixture/rollback-app',
      extends: BASE,
      fields: { nickname: { type: 'text' } },
    });
    expect(runtimeCoexistingModels().has(RUNTIME)).toBe(true);
    rollback();
    expect(ObjectRegistry.getClass(RUNTIME)).toBeUndefined();
    expect(runtimeCoexistingModels().has(RUNTIME)).toBe(false);
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(Scene);
  });

  it('keeps an unrelated coexisting model when another registration rolls back', () => {
    runtimeCoexistingModels().add('@fixture/a:Other');
    const rollback = ObjectRegistry.checkpointRegistrations([RUNTIME]);
    rollback();
    expect(runtimeCoexistingModels().has('@fixture/a:Other')).toBe(true);
  });
});
