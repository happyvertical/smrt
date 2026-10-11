import { createI18nContext } from '@happyvertical/smrt-ui/i18n';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { expect, it, vi } from 'vitest';
import Fixture from './LocalizedNotifications.fixture.svelte';

it('translates bell labels, interpolated count and retained errors through context changes', async () => {
  const provider = {
    getUnreadCount: vi.fn().mockResolvedValue(2),
    list: vi
      .fn()
      .mockResolvedValue([
        { id: 'one', title: 'Record title', occurredAt: '2026-01-01' },
      ]),
    markRead: vi.fn().mockRejectedValue(new Error('denied')),
    markAllRead: vi.fn().mockResolvedValue(undefined),
  };
  const messages = {
    'ui.notification_bell.label': 'Avis',
    'ui.notification_bell.unread': '{count} non lus',
    'ui.notification_bell.mark_one': 'Lire',
    'ui.notification_bell.mark_all': 'Tout lire',
    'ui.notification_bell.mark_error': 'Lecture impossible',
  };
  const store = createI18nContext({ locale: 'fr', messages });
  render(Fixture, { store, provider });
  await userEvent.click(await screen.findByRole('button', { name: /Avis/ }));
  expect(await screen.findByLabelText('2 non lus')).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Lire', exact: true }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Lecture impossible',
  );
  store.snapshot = { locale: 'en', messages: {} };
  await tick();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not mark notifications read.',
  );
  expect(
    screen.getByRole('dialog', { name: 'Notifications' }),
  ).toBeInTheDocument();
  expect(provider.list).toHaveBeenCalledTimes(1);
});

it('translates mock mailbox fixture data and dynamic send feedback without losing it on locale change', async () => {
  const messages = {
    'messages.mailbox_demo.disclaimer': 'Démonstration sans envoi réel.',
    'messages.mailbox_demo.compose': 'Rédiger',
    'messages.mailbox_demo.subject': 'Bienvenue',
    'messages.mailbox_demo.sent':
      'Simulation : {subject}. Aucun courriel envoyé.',
  };
  const store = createI18nContext({ locale: 'fr', messages });
  render(Fixture, { mailbox: true, store });
  expect(
    await screen.findByText('Démonstration sans envoi réel.'),
  ).toBeInTheDocument();
  expect(screen.getByText('Bienvenue')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Rédiger' }));
  await userEvent.type(
    screen.getByLabelText('To', { exact: true }),
    'recipient@example.com{Enter}',
  );
  await userEvent.type(
    screen.getByPlaceholderText('Subject', { exact: true }),
    'Bonjour',
  );
  await userEvent.type(
    screen.getByPlaceholderText('Write your message...'),
    'Example',
  );
  store.snapshot = {
    locale: 'fr-CA',
    messages: { ...messages, 'messages.mailbox_demo.inbox': 'Boîte démo' },
  };
  await tick();
  expect(screen.getByPlaceholderText('Subject', { exact: true })).toHaveValue(
    'Bonjour',
  );
  expect(screen.getByPlaceholderText('Write your message...')).toHaveValue(
    'Example',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Send', exact: true }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Simulation : Bonjour. Aucun courriel envoyé.',
  );
  store.snapshot = { locale: 'en', messages: {} };
  await tick();
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Mock send complete: Bonjour. No email was delivered.',
  );
});
