import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-chat/svelte', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AssistantDock: (
    await import('../../cookbook/__tests__/assistant-fixture.svelte')
  ).default,
}));

import OnboardingAssistant from '../OnboardingAssistant.svelte';

describe('tool-derived assistant introduction', () => {
  it('uses cookbook words and only offered actions when connected', () => {
    render(OnboardingAssistant, {
      props: {
        transport: { sendMessage: vi.fn() },
        registry: createDataSurfaceRegistry(),
        introduction: {
          lists: ['Customers', 'Classes'],
          actions: ['read', 'customize', 'imaginary'],
          configured: true,
        },
      },
    });
    expect(
      screen.getByText('I can help you work with Customers, Classes.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ask me to find what you need.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /Profile|imaginary|Available actions|request deletion|approval/,
      ),
    ).not.toBeInTheDocument();
  });
  it('keeps the introduction short and only describes supported help', () => {
    render(OnboardingAssistant, {
      props: {
        transport: { sendMessage: vi.fn() },
        registry: createDataSurfaceRegistry(),
        introduction: {
          lists: ['Classes', 'Members', 'Shop', 'Accounts', 'Journals'],
          actions: ['read', 'create', 'delete'],
          configured: true,
        },
      },
    });
    expect(
      screen.getByText('I can help you work with Classes, Members, Shop.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ask me to find things or add something new.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Accounts|Journals|approval|deletion|records/),
    ).not.toBeInTheDocument();
  });
  it('uses the shared unconfigured notice without a greeting, composer or transport work', () => {
    const sendMessage = vi.fn();
    const listThreads = vi.fn();
    render(OnboardingAssistant, {
      props: {
        transport: { sendMessage, listThreads },
        registry: createDataSurfaceRegistry(),
        introduction: {
          lists: ['Members'],
          actions: ['create'],
          configured: false,
        },
      },
    });
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-reason',
      'unconfigured',
    );
    expect(
      screen.getByRole('link', { name: 'Connect an AI to chat' }),
    ).toHaveAttribute('href', '/settings');
    expect(
      screen.queryByText(/I can help|Available actions/),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-dock')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(listThreads).not.toHaveBeenCalled();
  });
});
