import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { defineProtectedMessageHandoffSuite } from './helpers/protected-message-handoff-suite.js';

defineProtectedMessageHandoffSuite(async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  return {
    db,
    cleanup: async () => {
      await db.close?.();
    },
  };
});
