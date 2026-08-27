import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Progress from '../../feedback/Progress.svelte';
import Spinner from '../../feedback/Spinner.svelte';
import { createControlInteractionRegistry } from '../control-interaction.js';
import {
  snapSteppedNumber,
  validatesSteppedNumber,
} from '../control-value-validation.js';
import ErrorSummary from '../ErrorSummary.svelte';
import Fixture from './core-controls.fixture.svelte';
import DecimalSlidersFixture from './decimal-sliders.fixture.svelte';

describe('core controls', () => {
  it('provides distinct checkbox, switch, radio, slider, range, and segmented semantics', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    ).toBeChecked();

    await userEvent.click(
      screen.getByRole('switch', { name: 'Notifications' }),
    );
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: 'Viewer' }));
    expect(screen.getByRole('radio', { name: 'Viewer' })).toBeChecked();

    expect(screen.getAllByRole('slider')).toHaveLength(3);
    await userEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('registers all controls and keeps agent staging separate from human apply', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });
    expect(
      registry.list('settings').map((item) => item.identity.controlId),
    ).toEqual(
      expect.arrayContaining([
        'accepted',
        'notifications',
        'role',
        'volume',
        'price',
        'view',
      ]),
    );

    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'settings', controlId: 'volume' },
        value: 55,
      },
      { source: 'agent' },
    );
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('30');
    await registry.execute(
      {
        action: 'apply',
        identity: { formId: 'settings', controlId: 'volume' },
      },
      { source: 'agent', confirmed: true },
    );
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('30');
    await userEvent.click(screen.getByRole('button', { name: 'Apply Volume' }));
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('55');

    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'settings', controlId: 'volume' },
        value: '',
      },
      { source: 'agent' },
    );
    expect(
      registry.get({ formId: 'settings', controlId: 'volume' })?.state.staged
        ?.value,
    ).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Volume' }));
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('0');
    expect(
      registry.get({ formId: 'settings', controlId: 'volume' })?.state.staged,
    ).toBeUndefined();
  });

  it('canonicalizes scalar proposals before exposing them for review', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });

    for (const controlId of ['accepted', 'notes']) {
      expect(
        await registry.execute(
          {
            action: 'stage',
            identity: { formId: 'settings', controlId },
            value: { malformed: true },
          },
          { source: 'agent' },
        ),
      ).toMatchObject({ ok: false, reason: 'staged_value_invalid' });
      expect(
        registry.get({ formId: 'settings', controlId })?.state.staged,
      ).toBeUndefined();
    }

    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'settings', controlId: 'volume' },
        value: '55',
      },
      { source: 'agent' },
    );
    expect(
      registry.get({ formId: 'settings', controlId: 'volume' })?.state.staged
        ?.value,
    ).toBe(55);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Volume' }));
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('55');
  });

  it('applies decimal-step slider proposals without floating-point drift', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(DecimalSlidersFixture, { props: { registry } });
    const valueIdentity = { formId: 'decimal', controlId: 'value' };
    const rangeIdentity = { formId: 'decimal', controlId: 'range' };
    const tinyIdentity = { formId: 'decimal', controlId: 'tiny' };
    const microscopicIdentity = {
      formId: 'decimal',
      controlId: 'microscopic',
    };
    const microscopicRangeIdentity = {
      formId: 'decimal',
      controlId: 'microscopic-range',
    };

    const validCases = [
      { next: 0.3, min: 0.1, max: 1, step: 0.2 },
      { next: 3e-16, min: 1e-16, max: 9e-16, step: 2e-16 },
      { next: 3e-101, min: 1e-101, max: 9e-101, step: 2e-101 },
      { next: 1.12e-101, min: 1e-101, max: 1.9e-101, step: 3e-103 },
      {
        next: Number.MIN_VALUE * 3,
        min: Number.MIN_VALUE,
        max: Number.MIN_VALUE * 5,
        step: Number.MIN_VALUE,
      },
    ];
    for (const { next, min, max, step } of validCases) {
      expect(validatesSteppedNumber(next, min, max, step)).toBe(true);
      const snapped = snapSteppedNumber(next, min, max, step);
      expect(snapped).toBe(next);
      expect(validatesSteppedNumber(snapped, min, max, step)).toBe(true);
      expect(snapSteppedNumber(snapped, min, max, step)).toBe(snapped);
    }

    await registry.execute(
      { action: 'stage', identity: valueIdentity, value: 0.3 },
      { source: 'agent' },
    );
    await registry.execute(
      { action: 'stage', identity: tinyIdentity, value: 3e-16 },
      { source: 'agent' },
    );
    await registry.execute(
      { action: 'stage', identity: microscopicIdentity, value: 1.12e-101 },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: microscopicRangeIdentity,
        value: { min: 1.12e-101, max: 1.9e-101 },
      },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: rangeIdentity,
        value: { min: 0.3, max: 0.5 },
      },
      { source: 'agent' },
    );
    expect(registry.get(valueIdentity)?.state.staged).toMatchObject({
      value: 0.3,
      valid: true,
    });
    expect(registry.get(rangeIdentity)?.state.staged).toMatchObject({
      value: { min: 0.3, max: 0.5 },
      valid: true,
    });
    expect(registry.get(tinyIdentity)?.state.staged).toMatchObject({
      value: 3e-16,
      valid: true,
    });
    expect(registry.get(microscopicIdentity)?.state.staged).toMatchObject({
      value: 1.12e-101,
      valid: true,
    });
    expect(registry.get(microscopicRangeIdentity)?.state.staged).toMatchObject({
      value: { min: 1.12e-101, max: 1.9e-101 },
      valid: true,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Apply Value' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply Range' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Tiny value' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Microscopic value' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Microscopic range' }),
    );

    expect(registry.get(valueIdentity)?.state).toMatchObject({ value: 0.3 });
    expect(registry.get(rangeIdentity)?.state).toMatchObject({
      value: { min: 0.3, max: 0.5 },
    });
    expect(registry.get(tinyIdentity)?.state).toMatchObject({ value: 3e-16 });
    expect(registry.get(microscopicIdentity)?.state).toMatchObject({
      value: 1.12e-101,
    });
    expect(registry.get(microscopicRangeIdentity)?.state).toMatchObject({
      value: { min: 1.12e-101, max: 1.9e-101 },
    });
    expect(registry.get(valueIdentity)?.state.staged).toBeUndefined();
    expect(registry.get(rangeIdentity)?.state.staged).toBeUndefined();
    expect(registry.get(tinyIdentity)?.state.staged).toBeUndefined();
    expect(registry.get(microscopicIdentity)?.state.staged).toBeUndefined();
    expect(
      registry.get(microscopicRangeIdentity)?.state.staged,
    ).toBeUndefined();
    expect(screen.getByRole('slider', { name: 'Value' })).toHaveValue('0.3');
    expect(screen.getByRole('slider', { name: 'Minimum' })).toHaveValue('0.3');
    expect(screen.getByRole('slider', { name: 'Maximum' })).toHaveValue('0.5');
    expect(screen.getByRole('slider', { name: 'Tiny value' })).toHaveValue(
      '3e-16',
    );
    expect(
      screen.getByRole('slider', { name: 'Microscopic value' }),
    ).toHaveValue('1.12e-101');
    expect(
      screen.getByRole('slider', { name: 'Microscopic minimum' }),
    ).toHaveValue('1.12e-101');
    expect(
      screen.getByRole('slider', { name: 'Microscopic maximum' }),
    ).toHaveValue('1.9e-101');
  });

  it('marks constrained proposals invalid before the first valid-only batch', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry, validInitial: true } });
    const invalid = new Map<string, unknown>([
      ['accepted', false],
      ['notifications', false],
      ['role', 'administrator'],
      ['price', { min: 20, max: 83 }],
      ['view', 'cards'],
      ['notes', 'x'],
      ['pinned', 'yes'],
    ]);
    for (const [controlId, value] of invalid) {
      await registry.execute(
        {
          action: 'stage',
          identity: { formId: 'settings', controlId },
          value,
        },
        { source: 'agent' },
      );
      expect(
        registry.get({ formId: 'settings', controlId })?.state.staged?.valid,
      ).toBe(false);
    }

    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'settings', controlId: 'volume' },
        value: 12,
      },
      { source: 'agent' },
    );
    expect(
      registry.get({ formId: 'settings', controlId: 'volume' })?.state.staged
        ?.valid,
    ).toBe(false);
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'settings', controlId: 'volume' },
        value: 55,
      },
      { source: 'agent' },
    );
    expect(
      registry.get({ formId: 'settings', controlId: 'volume' })?.state.staged
        ?.valid,
    ).toBe(true);
    expect(await screen.findAllByRole('alert')).toHaveLength(invalid.size);

    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );

    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('55');
    expect(
      registry.get({ formId: 'settings', controlId: 'volume' })?.state.staged,
    ).toBeUndefined();
    for (const controlId of invalid.keys()) {
      expect(
        registry.get({ formId: 'settings', controlId })?.state.staged?.valid,
      ).toBe(false);
    }
  });

  it('is axe-clean as a composed form', async () => {
    const registry = createControlInteractionRegistry();
    const { container } = render(Fixture, { props: { registry } });
    await expectNoA11yViolations(container);
  });

  it('focuses the usable control inside an error-summary target', async () => {
    const { container } = render(ErrorSummary, {
      props: {
        errors: [
          {
            controlId: 'profile-photo',
            label: 'Profile photo',
            message: 'Choose a file',
          },
        ],
      },
    });
    const wrapper = document.createElement('div');
    wrapper.dataset.smrtControl = 'profile-photo';
    wrapper.scrollIntoView = () => undefined;
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    const file = document.createElement('input');
    file.type = 'file';
    wrapper.append(hidden, file);
    container.append(wrapper);

    await userEvent.click(
      screen.getByRole('button', { name: 'Profile photo: Choose a file' }),
    );

    expect(file).toHaveFocus();
  });
});

describe('progress feedback', () => {
  it('distinguishes determinate and indeterminate progress', async () => {
    const { rerender } = render(Progress, {
      props: { label: 'Import', value: 40, showValue: true },
    });
    expect(screen.getByRole('progressbar', { name: 'Import' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    await rerender({ label: 'Import', value: undefined });
    expect(
      screen.getByRole('progressbar', { name: 'Import' }),
    ).not.toHaveAttribute('aria-valuenow');
  });

  it('announces a spinner label', () => {
    render(Spinner, { props: { label: 'Saving changes' } });
    expect(screen.getByRole('status')).toHaveTextContent('Saving changes');
  });
});
