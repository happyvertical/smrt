/** Commerce canary: the Customer owns its naming declaration, Profile owns the name. */
import { readFileSync } from 'node:fs';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../../../core/src/scanner/types';
import {
  buildWebCollectionDefinition,
  selectWebCollectionEntries,
} from '../../../core/src/vite-plugin/web-collections';
import { screenRecordLabel } from '../../../smrt-svelte/src/components/screens/references';
import { createRecipeScreenReferences } from '../../../smrt-svelte/src/components/screens/source';
import { CustomerCollection } from '../collections/CustomerCollection';

let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;
afterEach(async () => {
  disableTenancy();
  await db?.close?.();
  db = undefined;
});

describe('Customer linked display label', () => {
  it('serves Profile names through generated REST and the screens reference source with bounded SQL', async () => {
    const database = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    db = database;
    const customers = await CustomerCollection.create({ db });
    const profiles = await ProfileCollection.create({ db });
    const types = await ProfileTypeCollection.create({ db });
    enableTenancy();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const type = await types.create({ name: 'Person' });
      const maya = await profiles.create({
        typeId: type.id,
        name: 'Maya Proof',
        email: 'maya@example.test',
      });
      const ada = await profiles.create({
        typeId: type.id,
        name: 'Ada Customer',
        email: 'ada@example.test',
      });
      const customer = await customers.create({ profileId: maya.id });
      await customers.create({ profileId: ada.id });
      await customers.create({ profileId: 'missing-profile' });
      const manifest = JSON.parse(
        readFileSync(
          new URL('../../dist/manifest.json', import.meta.url),
          'utf8',
        ),
      ) as SmartObjectManifest;
      const entry = selectWebCollectionEntries(manifest).find(
        (candidate) => candidate.obj.className === 'Customer',
      );
      expect(entry).toBeDefined();
      if (!entry) throw new Error('Customer REST collection missing');
      const definition = buildWebCollectionDefinition(entry, manifest);
      expect(definition.displayLabelField).toBe('displayLabel');
      expect(definition.fields.displayLabel).toMatchObject({
        type: 'text',
        readonly: true,
      });
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        {
          db,
          user: { id: 'owner' },
          permissions: ['customers.read', 'customers.list'],
        },
      );
      const requests: string[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        requests.push(url.toString());
        return api.generateHandler()(new Request(url, init));
      };
      const reference = createRecipeScreenReferences(
        { customers: definition },
        { fetch },
      ).customers;
      await reference.source.list(); // warm storage readiness before measuring
      const query = vi.spyOn(database, 'query');
      const page = await reference.source.search?.({
        query: 'Maya',
        offset: 0,
        limit: 1,
      });
      expect(page?.hasMore).toBe(false);
      expect(page?.rows).toMatchObject([
        { id: customer.id, displayLabel: 'Maya Proof' },
      ]);
      expect(screenRecordLabel(reference.definition, page?.rows[0] ?? {})).toBe(
        'Maya Proof',
      );
      expect(requests.at(-1)).toContain('displayLabel');
      expect(
        query.mock.calls.filter(([sql]) =>
          /^\s*(?:SELECT|WITH)\b/i.test(String(sql)),
        ),
      ).toHaveLength(1);
      query.mockRestore();
      if (!customer.id) throw new Error('Customer fixture has no id');
      const resolved = await reference.source.get?.(customer.id);
      expect(screenRecordLabel(reference.definition, resolved ?? {})).toBe(
        'Maya Proof',
      );
      const sorted = await reference.source.search?.({
        query: '',
        offset: 0,
        limit: 5,
      });
      expect(sorted?.rows.map((row) => row.displayLabel)).toEqual([
        'Ada Customer',
        'Maya Proof',
        'Unnamed customer',
      ]);
      maya.name = 'Maya Renamed';
      await maya.save();
      expect(
        (
          await reference.source.search?.({
            query: 'Renamed',
            offset: 0,
            limit: 1,
          })
        )?.rows,
      ).toMatchObject([{ displayLabel: 'Maya Renamed' }]);
    });
  });
});
