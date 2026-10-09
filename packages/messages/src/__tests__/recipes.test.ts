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

it('declares the supported provider boundary without wiring demo data to live mail', async () => {
  const { getMessagingProvider } = await import('../providers.js');
  for (const provider of MailboxRecipe.providers) {
    for (const option of provider.options)
      expect(getMessagingProvider(option)).toBeDefined();
  }
  expect(
    MailboxRecipe.providers.find((provider) => provider.id === 'email-inbox')
      ?.required,
  ).toBe(true);
  expect(
    MailboxRecipe.providers.find((provider) => provider.id === 'email-send')
      ?.required,
  ).toBe(false);
  expect(
    MailboxRecipe.surfaces.find((surface) => surface.kind === 'playground')
      ?.export,
  ).toContain('#MailboxDemo');
  expect(MailboxRecipe.demoSeed.data.messages[0].accountId).toBe(
    MailboxRecipe.demoSeed.data.accounts[0].id,
  );
  expect(MailboxRecipe.demoSeed.data.messages[0].body).toContain('mocked');
  expect(MailboxRecipe.runtime).toBe('both');
});

it('places the recipient-scoped bell in a supported slot with a required service provider', () => {
  expect(NotificationsRecipe.surfaces).toEqual([
    expect.objectContaining({
      kind: 'shell-widget',
      slot: 'header.end',
      export: '@happyvertical/smrt-svelte/notifications#NotificationBell',
    }),
  ]);
  expect(NotificationsRecipe.providers).toEqual([
    {
      id: 'notifications',
      kind: 'notifications',
      options: ['user-notification-service'],
      required: true,
    },
  ]);
  expect(NotificationsRecipe.nav).toEqual([]);
  expect(NotificationsRecipe.demoSeed.data.items[0].readAt).toBeNull();
  expect(NotificationsRecipe.runtime).toBe('both');
});
