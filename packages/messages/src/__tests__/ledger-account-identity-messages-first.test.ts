/**
 * #3098: smrt-messages and smrt-ledgers both declare `Account`. Loaded
 * messages first, each keeps its own identity, fields and table.
 */
import '../index';
import '@happyvertical/smrt-ledgers';

import { describe, it } from 'vitest';
import { assertMessagingAndLedgerAccountsCoexist } from './helpers/ledger-coexistence';

describe('messaging and ledger Account coexistence (messages first)', () => {
  it('resolves each Account to its own package and table', async () => {
    const db = await assertMessagingAndLedgerAccountsCoexist({
      type: 'sqlite',
      url: ':memory:',
    });
    await db.close?.();
  });
});
