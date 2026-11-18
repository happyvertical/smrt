import {
  createPreferenceStore,
  registerPreferenceKind,
} from '@happyvertical/smrt-preferences';
import { DEFAULT_MAX_CELLS } from '@happyvertical/smrt-spreadsheets/import';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import { getShellDb } from './host.ts';
import { HttpError } from './http.ts';
import { type Principal, runAs } from './owner.ts';

export { IMPORT_MAX_BYTES } from '../import-limits.ts';
export const IMPORT_CELL_RANGE = { min: 1000, max: 2_000_000 } as const;
const KIND = 'workbook-import';
const PERMISSION = 'import.customize';
export function validCellLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= IMPORT_CELL_RANGE.min &&
    value <= IMPORT_CELL_RANGE.max
  );
}
registerPreferenceKind(
  {
    kind: KIND,
    formatVersion: 1,
    permissions: { tenant: PERMISSION, user: PERMISSION },
    validate(payload) {
      const value = payload as { maxCells?: unknown } | null;
      if (value === null || value === undefined)
        return { ok: true, canonical: null, issues: [] };
      const ok =
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).every((k) => k === 'maxCells') &&
        validCellLimit(value.maxCells);
      return {
        ok,
        canonical: ok ? { maxCells: value.maxCells } : null,
        issues: ok
          ? []
          : [
              {
                path: 'maxCells',
                code: 'invalid_setting',
                message:
                  'Choose a whole number of cells from 1,000 to 2,000,000.',
              },
            ],
      };
    },
  },
  { replace: true },
);
registerPermissionDefinitions([
  {
    slug: PERMISSION,
    category: 'import',
    name: 'Change workbook import limits',
    description: 'Choose the maximum workbook size in cells',
  },
]);

export function importSettings(
  owner: Principal,
  maxCells?: unknown,
): Promise<{ maxCells: number }> {
  return runAs(
    { ...owner, scopes: [...(owner.scopes ?? []), PERMISSION] },
    async () => {
      const store = createPreferenceStore({ db: await getShellDb() });
      const state = await store.load(KIND, 'default');
      if (maxCells !== undefined) {
        if (!validCellLimit(maxCells))
          throw new HttpError(
            400,
            'Choose a whole number of cells from 1,000 to 2,000,000.',
          );
        const result = await store.save(KIND, 'default', {
          scope: 'tenant',
          payload: { maxCells },
          revision: state.tenant.revision,
        });
        if (!result.ok)
          throw new HttpError(
            409,
            'The setting changed. Refresh and try again.',
          );
        return { maxCells };
      }
      const stored = (state.tenant.payload as { maxCells?: unknown } | null)
        ?.maxCells;
      return { maxCells: validCellLimit(stored) ? stored : DEFAULT_MAX_CELLS };
    },
  );
}
