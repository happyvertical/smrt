import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import { createControlInteractionRegistry } from '../control-interaction.js';
import Fixture from './composite-controls.fixture.svelte';

describe('composite controls', () => {
  it('supports searchable, multiple, tag, and listbox selection', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });

    const country = screen.getByRole('combobox', { name: 'Country' });
    await userEvent.type(country, 'Can');
    await userEvent.click(screen.getByRole('option', { name: 'Canada' }));
    expect(country).toHaveValue('Canada');

    await userEvent.click(
      screen.getByRole('button', { name: /Channels.*Select options/ }),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Email' }));
    expect(screen.getByRole('option', { name: 'Email' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Topics' }),
      'svelte{Enter}',
    );
    expect(screen.getByText('svelte')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('option', { name: 'East' }));
    expect(screen.getByRole('option', { name: 'East' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('registers stable controls for agent adapters', () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });
    expect(
      registry.list('profile').map((item) => item.identity.controlId),
    ).toEqual(['country', 'channels', 'topics', 'region']);
  });

  it('rejects invalid choice and normalized-shape proposals at staging time', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });
    const invalid = new Map<string, unknown>([
      ['country', 'unknown'],
      ['channels', ['fax']],
      ['topics', ['duplicate', 'duplicate']],
      ['region', 'north'],
    ]);

    for (const [controlId, value] of invalid) {
      await registry.execute(
        {
          action: 'stage',
          identity: { formId: 'profile', controlId },
          value,
        },
        { source: 'agent' },
      );
      expect(
        registry.get({ formId: 'profile', controlId })?.state.staged?.valid,
      ).toBe(false);
    }

    expect(await screen.findAllByRole('alert')).toHaveLength(invalid.size);
  });

  it('reports effective disabled state from an ancestor fieldset', () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry, fieldsetDisabled: true } });

    expect(registry.list('profile').map((item) => item.state.disabled)).toEqual(
      [true, true, true, true],
    );
  });

  it('is axe-clean', async () => {
    const registry = createControlInteractionRegistry();
    const { container } = render(Fixture, { props: { registry } });
    await expectNoA11yViolations(container);
  });
});
