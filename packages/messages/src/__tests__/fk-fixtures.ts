import type { DatabaseInterface } from '@happyvertical/sql';
import { AccountCollection } from '../collections/AccountCollection.js';
import { MessageCollection } from '../collections/MessageCollection.js';
import { MessagingEndpointCollection } from '../collections/MessagingEndpointCollection.js';

/**
 * Complete the same-package parent side of message test schemas and seed any
 * explicit account identifiers used by child fixtures.
 */
export async function prepareMessageParents(
  db: DatabaseInterface,
  accountIds: string[] = [],
): Promise<void> {
  const accounts = await AccountCollection.create({ db });
  await MessagingEndpointCollection.create({ db });
  for (const id of accountIds) {
    const existing = await accounts.get({ id });
    if (existing) continue;
    await (
      await accounts.create({
        id,
        name: `Test account ${id}`,
        channelType: 'email',
        providerType: 'test',
      })
    ).save();
  }
}

/** Seed real Message parents for Attachment fixtures with explicit IDs. */
export async function seedMessageParents(
  db: DatabaseInterface,
  messageIds: string[],
): Promise<void> {
  const accountId = 'attachment-parent-account';
  await prepareMessageParents(db, [accountId]);
  const messages = await MessageCollection.create({ db });
  for (const id of messageIds) {
    const existing = await messages.get({ id });
    if (existing) continue;
    await (
      await messages.create({
        id,
        accountId,
        subject: `Attachment parent ${id}`,
      })
    ).save();
  }
}
