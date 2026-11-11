import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-chat/svelte', async () => ({
  AssistantDock: (
    await import('../../cookbook/__tests__/assistant-fixture.svelte')
  ).default,
}));

import OnboardingAssistant from '../OnboardingAssistant.svelte';

describe('tool-derived assistant introduction', () => {
  it('uses cookbook words and only offered actions; no engine is a calm connect prompt', () => {
    render(OnboardingAssistant, {
      props: {
        transport: { sendMessage: vi.fn() },
        registry: createDataSurfaceRegistry(),
        introduction: {
          lists: ['Customers', 'Classes'],
          actions: ['read', 'customize', 'imaginary'],
          configured: false,
        },
      },
    });
    expect(
      screen.getByText('I can help you work with Customers, Classes.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Available actions: read records, customize lists and fields.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect AI' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Profile|imaginary/)).not.toBeInTheDocument();
  });
});
