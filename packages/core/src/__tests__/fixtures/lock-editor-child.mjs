/**
 * A second process for the migration lock's PostgreSQL schedules (#5435):
 * an app model editor on its own pool, driven over IPC by the test.
 *
 * Messages in:  { op: 'open' } | { op: 'create_list', name } | { op: 'exit' }
 * Messages out: { at: 'ready' } | { done: op, revision } | { error: message }
 *
 * It imports the built core (`dist/`), so the test lane runs after a build,
 * and takes the database URL from `LOCK_CHILD_DATABASE_URL`.
 */
import { getDatabase } from '@happyvertical/sql';
import { createAppModelEditor } from '../../../dist/app-models.js';
import { COOKBOOK_SCHEMA_URL } from '../../../dist/cookbook/validate.js';

const TENANT = process.env.LOCK_CHILD_TENANT;
const db = await getDatabase({
  type: 'postgres',
  url: process.env.LOCK_CHILD_DATABASE_URL,
  dbid: `lock-child-${process.pid}`,
});
let editor;

const send = (message) => process.send?.(message);
process.on('message', async (message) => {
  try {
    if (message.op === 'open') {
      editor = await createAppModelEditor({
        db,
        application: process.env.LOCK_CHILD_APPLICATION ?? 'lock-child',
        tenantId: TENANT,
        packageName: '@lock-child/app',
        cookbook: {
          $schema: COOKBOOK_SCHEMA_URL,
          version: 1,
          recipes: [],
          features: [],
          policies: [],
        },
        catalog: { recipes: [], models: [] },
        authorize: () => true,
      });
      send({ done: 'open', revision: editor.snapshot().revision });
    } else if (message.op === 'create_list') {
      const receipt = await editor.apply(
        {
          type: 'create_list',
          name: message.name,
          list: {
            label: message.name,
            icon: 'list',
            displayField: 'title',
            fields: { title: { type: 'text' } },
          },
        },
        {
          actor: 'owner',
          tenantId: TENANT,
          expectedRevision: editor.snapshot().revision,
          requestId: `child-${Date.now()}-${Math.random()}`,
        },
      );
      send({ done: 'create_list', revision: receipt.revision });
    } else if (message.op === 'exit') {
      await db.close?.();
      process.exit(0);
    }
  } catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) });
  }
});
send({ at: 'ready' });
