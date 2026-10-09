import { describe, expect, it } from 'vitest';
import { Email } from '../models/Email.js';
import { MailboxRecipe, NotificationsRecipe } from '../recipes.js';

describe('messaging recipe composition', () => {
  it('shares one card without making notifications require a mailbox', () => {
    expect(MailboxRecipe.id).not.toBe(NotificationsRecipe.id);
    expect(MailboxRecipe.group).toEqual(NotificationsRecipe.group);
    expect(MailboxRecipe.section).toEqual(NotificationsRecipe.section);
    expect(MailboxRecipe.requires).toEqual([]);
    expect(NotificationsRecipe.requires).toEqual([]);
    expect(NotificationsRecipe.nav).toEqual([]);
  });

  it('gives all-mail and failed-send views distinct stable identities over the same email model', () => {
    const keys = MailboxRecipe.nav.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MailboxRecipe.nav.every((entry) => entry.model === Email)).toBe(
      true,
    );
    const all = MailboxRecipe.nav.find((entry) => entry.key === 'mailbox');
    const failed = MailboxRecipe.nav.find(
      (entry) => entry.key === 'failed-sends',
    );
    expect(all?.filter).toBeUndefined();
    expect(failed?.filter).toEqual({ field: 'sendStatus', value: 'failed' });
    expect(new Email({ sendStatus: 'failed' }).sendStatus).toBe(
      failed?.filter?.value,
    );
    // Received mail can retain the default draft sendStatus without being a draft.
    expect(new Email().sendStatus).not.toBe(failed?.filter?.value);
    expect(new Email({ sendStatus: 'sent' }).sendStatus).not.toBe(
      failed?.filter?.value,
    );
  });
});
