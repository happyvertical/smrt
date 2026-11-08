import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { defineProfileRecipientSuite } from './helpers/profile-recipient-suite.js';

defineProfileRecipientSuite(
  async () => ({
    db: await getTestDatabase({ type: 'sqlite', url: ':memory:' }),
  }),
  'sqlite',
);
