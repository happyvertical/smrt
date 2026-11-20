/**
 * #5143: the run-time coexistence set is part of the subtype lineage a
 * registration checkpoint and a registry test snapshot save, by value, and
 * their restores bring back exactly.
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
  snapshotSubtypeLineage,
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

  function registerCoexistingScene(packageName: string): string {
    registerRuntimeModel({
      name: 'Scene',
      packageName,
      extends: BASE,
      fields: { nickname: { type: 'text' } },
    });
    return `${packageName}:Scene`;
  }

  function registerBaseScene(): void {
    class Scene extends SmrtObject {}
    ObjectRegistry.register(Scene, {
      name: 'Scene',
      packageName: '@fixture/rollback-video',
      tableName: 'scenes',
    });
  }

  it('restores the coexistence set by value across a registry snapshot restore', () => {
    registerBaseScene();
    const runtimeKey = registerCoexistingScene('@fixture/rollback-app');
    expect(runtimeCoexistingModels().has(runtimeKey)).toBe(true);
    const restoreSnapshot = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    expect(runtimeCoexistingModels().size).toBe(0);
    restoreSnapshot();
    expect([...runtimeCoexistingModels()]).toEqual([runtimeKey]);
    expect(ObjectRegistry.getClass(runtimeKey)).toBeDefined();
  });

  it('drops a coexistence key recorded after the registry snapshot', () => {
    registerBaseScene();
    const runtimeKey = registerCoexistingScene('@fixture/rollback-app');
    const restoreSnapshot = snapshotObjectRegistryState();
    const laterKey = registerCoexistingScene('@fixture/rollback-later');
    expect(runtimeCoexistingModels().has(laterKey)).toBe(true);
    restoreSnapshot();
    expect([...runtimeCoexistingModels()]).toEqual([runtimeKey]);
    expect(ObjectRegistry.getClass(laterKey)).toBeUndefined();
  });

  it('restores only the snapshotted lineage, coexistence set included, without a registry clear', () => {
    runtimeCoexistingModels().add('@fixture/a:Kept');
    const restoreLineage = snapshotSubtypeLineage();
    runtimeCoexistingModels().add('@fixture/a:Later');
    restoreLineage();
    expect([...runtimeCoexistingModels()]).toEqual(['@fixture/a:Kept']);
  });

  it('keeps an unrelated coexisting model when another registration rolls back', () => {
    runtimeCoexistingModels().add('@fixture/a:Other');
    const rollback = ObjectRegistry.checkpointRegistrations([RUNTIME]);
    rollback();
    expect(runtimeCoexistingModels().has('@fixture/a:Other')).toBe(true);
  });
});
