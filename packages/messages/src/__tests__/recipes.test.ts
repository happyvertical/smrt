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

  it('gives all-mail and draft views distinct stable identities over the same email model', () => {
    const keys = MailboxRecipe.nav.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MailboxRecipe.nav.every((entry) => entry.model === Email)).toBe(
      true,
    );
    const all = MailboxRecipe.nav.find((entry) => entry.key === 'mailbox');
    const drafts = MailboxRecipe.nav.find((entry) => entry.key === 'drafts');
    expect(all?.filter).toBeUndefined();
    expect(drafts?.filter).toEqual({ field: 'sendStatus', value: 'draft' });
    expect(new Email({ sendStatus: 'draft' }).sendStatus).toBe(
      drafts?.filter?.value,
    );
    expect(new Email({ sendStatus: 'sent' }).sendStatus).not.toBe(
      drafts?.filter?.value,
    );
  });
});
