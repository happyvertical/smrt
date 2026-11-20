import { getTestDatabase } from '../testing/database.js';
import {
  CREATE_FLAG_CLASSES,
  createControlFlagSuite,
} from './create-control-flags.cases.js';

createControlFlagSuite('sqlite', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: CREATE_FLAG_CLASSES,
  });
  return { db, close: async () => void (await db.close?.()) };
});
