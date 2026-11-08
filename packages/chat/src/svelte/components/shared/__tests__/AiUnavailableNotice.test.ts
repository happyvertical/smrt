// @vitest-environment jsdom
/**
 * "AI is off, open settings" (#4757): the reason's sentence and, when the
 * host supplies one, a link to its AI settings page.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import AiUnavailableNotice from '../AiUnavailableNotice.svelte';

describe('AiUnavailableNotice', () => {
  it('says AI is off and links to the host settings page', () => {
    render(AiUnavailableNotice, {
      props: { status: { reason: 'off' }, settingsHref: '/settings/ai' },
    });
    expect(screen.getByText('AI is off.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open AI settings' }),
    ).toHaveAttribute('href', '/settings/ai');
  });

  it('names each reason and omits the link without a host target', () => {
    render(AiUnavailableNotice, {
      props: { status: { reason: 'unconfigured' } },
    });
    expect(screen.getByText('AI is not set up yet.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('uses the host link label', () => {
    render(AiUnavailableNotice, {
      props: {
        status: { reason: 'entitlement' },
        settingsHref: '/billing',
        settingsLabel: 'Upgrade',
      },
    });
    expect(screen.getByRole('link', { name: 'Upgrade' })).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(AiUnavailableNotice, {
      props: { status: { reason: 'off' }, settingsHref: '/settings/ai' },
    });
    await expectNoA11yViolations(container);
  });
});
