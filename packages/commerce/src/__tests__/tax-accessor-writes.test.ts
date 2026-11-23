/**
 * A declared writable accessor (`api.writable`) may change its own backing
 * column, while a direct write of that column stays refused (#5195):
 * `TaxCode.components` over `componentsJson` and `TaxSettings.taxRegistrations`
 * over `taxRegistrationsJson`.
 */
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import { TaxCodeCollection } from '../collections/TaxCodeCollection';
import { TaxComponentCollection } from '../collections/TaxComponentCollection';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection';

const TENANT = '11111111-1111-4111-8111-111111111111';
const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;
afterEach(async () => {
  disableTenancy();
  await db?.close?.();
  db = undefined;
});

async function setup() {
  db = await getTestDatabase({ type: databaseType, url: ':memory:' });
  const codes = await TaxCodeCollection.create({ db });
  const components = await TaxComponentCollection.create({ db });
  const settings = await TaxSettingsCollection.create({ db });
  enableTenancy();
  const segment = (name: string) =>
    ObjectRegistry.getClass(name)?.collection as string;
  const permissions = ['TaxCode', 'TaxSettings'].flatMap((name) =>
    ['create', 'update', 'read'].map((op) => `${segment(name)}.${op}`),
  );
  const handler = new APIGenerator(
    { basePath: '/api', authMiddleware: () => async (req) => req },
    { db, tenantId: TENANT, user: { id: 'owner' }, permissions },
  ).generateHandler();
  const put = (path: string, body: unknown) =>
    handler(
      new Request(`http://localhost/api/${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  return { codes, components, settings, put, segment };
}

describe('declared writable accessors over their backing column', () => {
  it('TaxCode.components writes componentsJson; componentsJson itself is refused', async () => {
    const { codes, components, put, segment } = await setup();
    await withTenant({ tenantId: TENANT }, async () => {
      const gst = await components.create({ name: 'GST', percent: '5' });
      const pst = await components.create({ name: 'PST', percent: '7' });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id as string, compound: false }],
      } as never);
      const path = `${segment('TaxCode')}/${code.id}`;
      const parts = [
        { taxComponentId: gst.id as string, compound: false },
        { taxComponentId: pst.id as string, compound: true },
      ];

      const changed = await put(path, { components: parts });
      expect(changed.status, await changed.clone().text()).toBe(200);
      const stored = await codes.get(
        code.id as string,
        {
          cache: false,
        } as never,
      );
      expect(JSON.parse(stored?.componentsJson ?? '')).toEqual(parts);

      const direct = await put(path, { componentsJson: '[]', name: 'x' });
      expect(direct.status).toBe(400);
      expect((await direct.json()).error).toMatchObject({
        code: 'VALIDATION_FIELD_NOT_WRITABLE',
        details: { field: 'componentsJson' },
      });
      const after = await codes.get(
        code.id as string,
        {
          cache: false,
        } as never,
      );
      expect(JSON.parse(after?.componentsJson ?? '')).toEqual(parts);
    });
  });

  it('TaxSettings.taxRegistrations writes taxRegistrationsJson; the column itself is refused', async () => {
    const { settings, components, put, segment } = await setup();
    await withTenant({ tenantId: TENANT }, async () => {
      const gst = await components.create({ name: 'GST', percent: '5' });
      const row = await settings.create({} as never);
      const path = `${segment('TaxSettings')}/${row.id}`;
      const registrations = [
        {
          taxComponentId: gst.id as string,
          number: '123456789RT0001',
          label: 'GST',
        },
      ];

      const changed = await put(path, { taxRegistrations: registrations });
      expect(changed.status, await changed.clone().text()).toBe(200);
      const stored = await settings.get(
        row.id as string,
        {
          cache: false,
        } as never,
      );
      expect(JSON.parse(stored?.taxRegistrationsJson ?? '')).toEqual(
        registrations,
      );

      const direct = await put(path, { taxRegistrationsJson: '[]' });
      expect(direct.status).toBe(400);
      expect((await direct.json()).error).toMatchObject({
        code: 'VALIDATION_FIELD_NOT_WRITABLE',
        details: { field: 'taxRegistrationsJson' },
      });
    });
  });
});
