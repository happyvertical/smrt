// Format-1 stored definitions reconstructed from origin/main's definition.ts
// fbfe8dcbc2a474cb0c468536682da3bdf776e3d9: RECIPES and host.ts enableRecipe/defineModel (before calculated fields/reports).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  type AppDefinition,
  AppHost,
  MemoryVersionStore,
  validate,
} from './index.ts';

const profile: AppDefinition = {
  format: 1,
  name: 'My app',
  recipes: ['profiles'],
  models: {
    Profile: {
      label: 'Profile',
      extends: '@happyvertical/smrt-profiles:Profile',
      fields: {},
      methods: {},
    },
  },
};
const plain: AppDefinition = {
  format: 1,
  name: 'My app',
  recipes: [],
  models: {
    Customer: {
      fields: { name: { type: 'text', required: true } },
      methods: {},
    },
    Sale: {
      fields: {
        title: { type: 'text' },
        total: { type: 'money' },
        day: { type: 'date' },
        customer: { type: 'reference', ref: 'Customer' },
        status: { type: 'choice', choices: ['open', 'paid'] },
      },
      methods: {},
    },
  },
};
async function stored(definition: AppDefinition) {
  const store = new MemoryVersionStore();
  await store.append({
    version: 1,
    parent: null,
    author: 'main',
    summary: 'stored before #4916',
    definition,
    migration: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await store.setCurrent(1);
  return store;
}
it.each([
  ['profile recipe', profile],
  ['plain money/date/reference/choice', plain],
] as const)('boots the main-stored %s definition', async (_name, definition) => {
  expect(validate(definition)).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), 'compat-4916-'));
  let host: AppHost | undefined;
  try {
    const store = await stored(definition);
    host = await AppHost.open(dir, { store });
    expect(host.version).toBe(1);
    expect(host.describe().reports).toEqual({});
    if (definition.recipes.length) {
      const record = await host.create('Profile', {
        name: 'Ada',
        email: 'ada@example.test',
      });
      expect((await host.list('Profile')).map((r) => r.id)).toContain(
        record.id,
      );
    } else {
      const customer = await host.create('Customer', { name: 'Ada' });
      const sale = await host.create('Sale', {
        title: 'First',
        total: 1234,
        day: '2026-01-15',
        customer: customer.id,
        status: 'paid',
      });
      expect(sale).toMatchObject({
        total: 1234,
        customer: customer.id,
        status: 'paid',
      });
      expect(new Date(sale.day as string).toISOString()).toBe(
        '2026-01-15T00:00:00.000Z',
      );
    }
    await host.close();
    host = undefined;
    host = await AppHost.open(dir, { store });
    expect(host.version).toBe(1);
    expect(
      await host.list(definition.recipes.length ? 'Profile' : 'Sale'),
    ).toHaveLength(1);
  } finally {
    await host?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('refuses an invalid stored definition naming its model, field and reason', async () => {
  const invalid = structuredClone(plain);
  invalid.models.Sale.fields.customer.ref = 'Missing';
  const dir = mkdtempSync(join(tmpdir(), 'compat-invalid-4916-'));
  try {
    await expect(
      AppHost.open(dir, { store: await stored(invalid) }),
    ).rejects.toThrow(
      /stored definition is invalid:.*Sale.customer: reference needs ref to a model/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
