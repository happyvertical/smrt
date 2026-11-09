import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureResolver } from './feature-resolver.js';
import {
  KillSwitchService,
  readKillSwitch,
  setKillSwitch,
} from './kill-switch.js';
import { FeatureOverrideEffect } from './types.js';

const KEY = 'inference.hosted.enabled';

describe('kill switches (#4760)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const db = await getTestDatabase({
      classes: ['FeatureDefinition', 'FeatureOverride'],
    });
    closers.push(async () => {
      if (typeof (db as any).close === 'function') await (db as any).close();
    });
    const overrides = (await (FeatureOverrideCollection as any).create({
      db,
    })) as FeatureOverrideCollection;
    return { db, overrides };
  }

  it('is on with no rows, off for a tenant DISABLE, and only for that tenant', async () => {
    const { overrides } = await setup();
    expect(await readKillSwitch(overrides, KEY, { tenantId: 't1' })).toEqual({
      key: KEY,
      enabled: true,
    });
    await setKillSwitch(overrides, KEY, { enabled: false, tenantId: 't1' });
    expect(await readKillSwitch(overrides, KEY, { tenantId: 't1' })).toEqual({
      key: KEY,
      enabled: false,
      disabledBy: 'tenant',
    });
    expect(await readKillSwitch(overrides, KEY, { tenantId: 't2' })).toEqual({
      key: KEY,
      enabled: true,
    });
    expect(await readKillSwitch(overrides, KEY)).toEqual({
      key: KEY,
      enabled: true,
    });
  });

  it('a global DISABLE beats any tenant row, unlike a flag', async () => {
    const { db, overrides } = await setup();
    await overrides.setTenantOverride(KEY, 't1', FeatureOverrideEffect.ENABLE);
    await setKillSwitch(overrides, KEY, { enabled: false });
    expect(await readKillSwitch(overrides, KEY, { tenantId: 't1' })).toEqual({
      key: KEY,
      enabled: false,
      disabledBy: 'global',
    });
    // A kill switch has no definition, so the flag resolver (whose tenant
    // ENABLE would win) refuses to read it at all.
    const flags = new FeatureResolver(
      { db },
      { tenantHierarchyLoader: async () => null },
    );
    await expect(flags.isEnabled(KEY, { tenantId: 't1' })).rejects.toThrow(
      /not declared/,
    );

    // Enabling a tenant never lifts the global switch.
    expect(
      await setKillSwitch(overrides, KEY, { enabled: true, tenantId: 't1' }),
    ).toMatchObject({ enabled: false, disabledBy: 'global' });
    expect(await setKillSwitch(overrides, KEY, { enabled: true })).toEqual({
      key: KEY,
      enabled: true,
    });
  });

  it('matches a tenant id typed in either case and refuses a blank one', async () => {
    const { overrides } = await setup();
    const id = 'A1B2C3D4-0000-4000-8000-00000000000F';
    await setKillSwitch(overrides, KEY, { enabled: false, tenantId: id });
    for (const spelling of [id, id.toLowerCase()]) {
      expect(
        await readKillSwitch(overrides, KEY, { tenantId: spelling }),
      ).toMatchObject({ enabled: false, disabledBy: 'tenant' });
    }
    // A verbatim row written by another path (an admin UI) also applies,
    // and enabling by either spelling clears both rows.
    await overrides.setTenantOverride(KEY, id, FeatureOverrideEffect.DISABLE);
    expect(
      await readKillSwitch(overrides, KEY, { tenantId: id }),
    ).toMatchObject({ enabled: false });
    await setKillSwitch(overrides, KEY, {
      enabled: true,
      tenantId: id.toLowerCase(),
    });
    expect(await readKillSwitch(overrides, KEY, { tenantId: id })).toEqual({
      key: KEY,
      enabled: true,
    });
    await expect(
      setKillSwitch(overrides, KEY, { enabled: false, tenantId: '  ' }),
    ).rejects.toThrow(/blank/);
  });

  it('KillSwitchService reads and writes over one database', async () => {
    const { db } = await setup();
    const service = new KillSwitchService({ db, defaultListLimit: 1 } as never);
    await service.set(KEY, { enabled: false });
    await expect(service.read(KEY, { tenantId: 't1' })).resolves.toEqual({
      key: KEY,
      enabled: false,
      disabledBy: 'global',
    });
  });
});
