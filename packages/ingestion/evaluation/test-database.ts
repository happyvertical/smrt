import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { ReferenceReviewHostOptions } from '../reference/review-host.js';
import { dropExecutionDatabase } from '../src/test-support/postgres-cleanup.js';

/** Provisioning only: the maintained host still migrates its declared model graph. */
export async function evaluationDatabase(): Promise<{
  database?: ReferenceReviewHostOptions['database'];
  close(): Promise<void>;
}> {
  if (process.env.EVALUATION_DATABASE !== 'postgres')
    return { close: async () => {} };
  const base = process.env.DATABASE_URL;
  if (!base) throw Error('PostgreSQL evaluation URL required');
  const admin = await getTestDatabase({
    type: 'postgres',
    url: base,
    classes: [],
    includeSystemTables: false,
  });
  const name = `exec_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.close?.();
    throw error;
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    database: { type: 'postgres', url: url.toString() },
    close: async () => {
      try {
        await dropExecutionDatabase(admin, name);
      } finally {
        await admin.close?.();
      }
    },
  };
}
