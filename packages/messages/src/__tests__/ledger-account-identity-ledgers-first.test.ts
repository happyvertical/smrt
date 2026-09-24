/**
 * #3098: smrt-messages and smrt-ledgers both declare `Account`. Loaded
 * ledgers first, each keeps its own identity, fields and table.
 */
import '@happyvertical/smrt-ledgers';
import '../index';

import { describe, it } from 'vitest';
import { assertMessagingAndLedgerAccountsCoexist } from './helpers/ledger-coexistence';

describe('messaging and ledger Account coexistence (ledgers first)', () => {
  it('resolves each Account to its own package and table', async () => {
    const db = await assertMessagingAndLedgerAccountsCoexist({
      type: 'sqlite',
      url: ':memory:',
    });
    await db.close?.();
  });
});
