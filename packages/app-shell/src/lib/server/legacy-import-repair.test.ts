// A table imported before workbook bookkeeping stopped being required is
// repaired when the app opens, and required-field errors name the label.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { hostOwner } from '../../test/engine-principal.ts';
import { closeHost, getHost } from './host.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
});
afterEach(async () => {
  await h.close();
});

async function importedLegacyTable() {
  const live = await getHost();
  await live.execute(
    {
      type: 'defineModel',
      name: 'Walks',
      fields: {
        workbookRow: {
          type: 'integer',
          label: 'Workbook row',
          required: true,
        },
        workbookLookup: { type: 'text', label: 'Workbook lookup' },
        dogName: { type: 'text', label: 'Dog name', required: true },
      },
    },
    { author: h.owner.id },
  );
  await live.create(hostOwner(live), 'Walks', {
    workbookRow: 2,
    dogName: 'Biscuit',
  });
  await live.execute(
    { type: 'hideField', model: 'Walks', field: 'workbookRow' },
    { author: h.owner.id },
  );
  // the app is closed and opened again, as when the owner returns to it
  await closeHost();
  return getHost();
}

it('opens a table imported with the old required flag so records can be added and edited', async () => {
  const live = await importedLegacyTable();
  expect(live.def.models.Walks.fields.workbookRow).toMatchObject({
    required: false,
    hidden: true,
  });
  const added = await live.create(hostOwner(live), 'Walks', {
    dogName: 'Pepper',
  });
  expect(added).toMatchObject({ dogName: 'Pepper' });
  const edited = await live.update(hostOwner(live), 'Walks', String(added.id), {
    dogName: 'Pepper II',
  });
  expect(edited).toMatchObject({ dogName: 'Pepper II' });
  // the imported row keeps its number
  const stored = await live.readStoredRows(
    hostOwner(live),
    'Walks',
    ['workbookRow'],
    'workbookRow',
  );
  expect(stored).toEqual([{ workbookRow: null }, { workbookRow: 2 }]);
});

it('names the field label, never the field id, when a required value is missing', async () => {
  const live = await importedLegacyTable();
  const error = await live
    .create(hostOwner(live), 'Walks', {})
    .catch((e: Error) => e);
  expect((error as Error).message).toBe('Dog name is required for Walks');
  const row = await live.create(hostOwner(live), 'Walks', { dogName: 'Rex' });
  await expect(
    live.update(hostOwner(live), 'Walks', String(row.id), { dogName: '' }),
  ).rejects.toThrow('Dog name is required for Walks');
});
