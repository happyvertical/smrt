import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { getDatabaseFromSqliteSchemaTemplate } from '../../../../sqlite-schema-template.js';

const stateDirectoryPath = process.env.SMRT_TEMPLATE_STATE_PATH;

it('creates a worker-owned schema template', async () => {
  if (!stateDirectoryPath) throw new Error('Missing SMRT_TEMPLATE_STATE_PATH');
  const targetPath = join(dirname(stateDirectoryPath), 'worker-target.db');
  await getDatabaseFromSqliteSchemaTemplate({
    cacheKey: 'worker-lifecycle',
    databaseOptions: { type: 'sqlite', url: targetPath },
    getDatabase: async () => ({
      query: async (_sql: string, snapshotPath?: unknown) => {
        if (typeof snapshotPath === 'string') writeFileSync(snapshotPath, '');
      },
    }),
    prepare: async () => {},
  });
  const state = globalThis as typeof globalThis & {
    __smrtVitestSqliteSchemaTemplates?: { directory: string };
  };
  expect(state.__smrtVitestSqliteSchemaTemplates?.directory).toBeTruthy();
  mkdirSync(dirname(stateDirectoryPath), { recursive: true });
  writeFileSync(
    stateDirectoryPath,
    state.__smrtVitestSqliteSchemaTemplates?.directory ?? '',
  );
});
