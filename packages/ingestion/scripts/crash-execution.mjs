// Real process-death fixture: parent owns schema and provider receipt storage.
import { writeFile } from 'node:fs/promises';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import '@happyvertical/smrt-content';
import { getDatabase } from '@happyvertical/sql';
import { IngestionService } from '../dist/server.js';
const config = JSON.parse(process.env.INGESTION_EXECUTION_CRASH_CONFIG);
const db = await getDatabase({ type: config.dialect, url: process.env.INGESTION_EXECUTION_CRASH_DB });
const handler = {
  ...config.handler,
  validate: async () => ({ ok: true }),
  preview: async (args) => ({ display: args, normalizedArgs: args, targetPreconditions: [] }),
  execution: {
    kind: 'external',
    submit: async (_args, _context, key) => {
      await writeFile(config.providerReceipt, JSON.stringify({ key, receipt: 'provider-accepted' }), { flag: 'wx' });
      process.kill(process.pid, 'SIGKILL');
      throw new Error('unreachable');
    },
    reconcile: async () => ({ kind: 'unknown' }),
  },
};
const service = new IngestionService({
  db, assets: await createAssetRuntime({ db, storage: config.storage }),
  scope: config.scope, authorize: async () => true,
  jobTarget: config.jobTarget, now: () => new Date(config.now), purgeDerived: async () => {},
  execution: {
    handlers: [handler], authorize: async () => config.access,
    assertTarget: async () => { throw new Error('No record result expected'); },
  },
});
await service.applyAction(config.actionId);
process.exit(74);
