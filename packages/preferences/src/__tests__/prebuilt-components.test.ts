import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { subscribeRuntimeExposure } from '@happyvertical/smrt-core/runtime-exposure';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPrebuiltComponentsPreference,
  createPreferenceStore,
  PREBUILT_COMPONENTS_PREFERENCE_KIND,
  PreferenceAccessError,
  type PreferenceStore,
} from '../index.js';

let db: DatabaseInterface;
let store: PreferenceStore;
let preference: ReturnType<typeof createPrebuiltComponentsPreference>;
let tenantId: string;
let userId: string;
let owner: boolean;
const as = <T>(
  fn: () => Promise<T>,
  tenant = tenantId,
  permissions = ['recipes.configure'],
) =>
  withTenant(
    { tenantId: tenant, userId, permissions: new Set(permissions) },
    fn,
  );
beforeEach(async () => {
  setupTestTenancy();
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['UiPreferenceRecord'],
  });
  store = createPreferenceStore({ db });
  tenantId = randomUUID();
  userId = randomUUID();
  owner = true;
  preference = createPrebuiltComponentsPreference({
    store,
    isOwner: async (principal) => owner && principal.userId === userId,
  });
});
afterEach(async () => {
  resetTenancy();
  await db?.close?.();
});

describe('pre-built components preference (SQLite)', () => {
  it('defaults on after load, persists a single tenant toggle and invalidates tool catalogs', async () => {
    expect(preference.isEnabled(tenantId)).toBe(false);
    const changed = vi.fn();
    const unsubscribe = subscribeRuntimeExposure(changed);
    expect(await as(() => preference.read())).toEqual({
      enabled: true,
      revision: null,
    });
    expect(preference.isEnabled(tenantId)).toBe(true);
    expect(await as(() => preference.write(false, null))).toMatchObject({
      ok: true,
    });
    expect(await as(() => preference.read())).toMatchObject({ enabled: false });
    expect(preference.isEnabled(tenantId)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
    const reopened = createPrebuiltComponentsPreference({
      store,
      isOwner: async () => true,
    });
    expect(await as(() => reopened.read())).toMatchObject({ enabled: false });
    unsubscribe();
  });
  it('refuses non-owners, missing permissions, personal overrides and invalid payloads', async () => {
    owner = false;
    await expect(
      as(() => preference.write(false, null)),
    ).rejects.toBeInstanceOf(PreferenceAccessError);
    owner = true;
    expect(
      await as(() => preference.write(false, null), tenantId, []),
    ).toMatchObject({ ok: false, reason: 'not_allowed' });
    await expect(
      as(() =>
        store.save(PREBUILT_COMPONENTS_PREFERENCE_KIND, 'app', {
          scope: 'user',
          revision: null,
          payload: { enabled: true },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    await expect(
      as(() =>
        store.save(PREBUILT_COMPONENTS_PREFERENCE_KIND, 'app', {
          scope: 'tenant',
          revision: null,
          payload: { enabled: 'no' },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    await expect(preference.read()).rejects.toBeInstanceOf(
      PreferenceAccessError,
    );
  });
  it('isolates tenants and uses the store revision to refuse stale edits', async () => {
    const other = randomUUID();
    await as(() => preference.write(false, null));
    expect(await as(() => preference.read(), other)).toEqual({
      enabled: true,
      revision: null,
    });
    expect(preference.isEnabled(tenantId)).toBe(false);
    expect(preference.isEnabled(other)).toBe(true);
    expect(await as(() => preference.write(true, null))).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    const current = await as(() => preference.read());
    expect(
      await as(() => preference.write(true, current.revision)),
    ).toMatchObject({ ok: true });
    expect(preference.isEnabled(tenantId)).toBe(true);
  });
  it('closes unreadable and malformed preferences and supports explicit external invalidation', async () => {
    await as(() => preference.read());
    preference.invalidate(tenantId);
    expect(preference.isEnabled(tenantId)).toBe(false);
    await as(() => preference.write(true, null));
    await db.query(
      'UPDATE _smrt_ui_preferences SET payload_json = ? WHERE tenant_id = ?',
      JSON.stringify({ enabled: 'wrong' }),
      tenantId,
    );
    expect(await as(() => preference.read())).toMatchObject({ enabled: false });
    const load = vi
      .spyOn(store, 'load')
      .mockRejectedValueOnce(new Error('unreadable'));
    await expect(as(() => preference.read())).rejects.toThrow('unreadable');
    expect(preference.isEnabled(tenantId)).toBe(false);
    load.mockRestore();
  });
});
