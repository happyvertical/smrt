// @vitest-environment jsdom
/**
 * Component tests for ModeSwitch and AdvancedFields (#2048).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { ResolvedObjectFieldPolicy } from '../../types.js';
import AdvancedFields from '../components/AdvancedFields.svelte';
import FieldPolicyProvider from '../components/FieldPolicyProvider.svelte';
import ModeSwitch from '../components/ModeSwitch.svelte';
import AdvancedFieldsFixture from './fixtures/AdvancedFieldsFixture.svelte';
import ModeSwitchFixture from './fixtures/ModeSwitchFixture.svelte';

function makePolicy(): ResolvedObjectFieldPolicy {
  return {
    objectRef: '@test:Widget',
    fields: {
      name: {
        fieldName: 'name',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'basic',
        help: 'Name',
        label: 'Name',
        order: 1,
        group: null,
        locked: false,
        required: true,
      },
      secretKey: {
        fieldName: 'secretKey',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'advanced',
        help: 'Secret key',
        label: 'Secret Key',
        order: 2,
        group: null,
        locked: false,
        required: false,
      },
      another: {
        fieldName: 'another',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'advanced',
        help: 'Another',
        label: 'Another',
        order: 3,
        group: null,
        locked: false,
        required: false,
      },
    },
  };
}

describe('ModeSwitch', () => {
  it('renders basic and advanced options', () => {
    render(ModeSwitchFixture, { props: { policy: makePolicy() } });

    // SegmentedControl renders as a radiogroup with radio options
    expect(
      screen.getByRole('radiogroup', { name: 'View mode' }),
    ).toBeInTheDocument();
  });

  it('switching to advanced reveals advanced fields', async () => {
    render(ModeSwitchFixture, { props: { policy: makePolicy() } });

    expect(
      screen.queryByRole('textbox', { name: /Secret Key/ }),
    ).not.toBeInTheDocument();

    // SegmentedControl renders radio buttons — click the Advanced label
    await userEvent.click(screen.getByText('Advanced'));
    await tick();

    expect(
      screen.getByRole('textbox', { name: /Secret Key/ }),
    ).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ModeSwitchFixture, {
      props: { policy: makePolicy() },
    });
    await expectNoA11yViolations(container);
  });
});

describe('AdvancedFields', () => {
  it('shows disclosure with field count in advanced mode', async () => {
    render(AdvancedFieldsFixture, {
      props: { policy: makePolicy(), mode: 'advanced' },
    });
    await tick();

    expect(screen.getByText(/Advanced · 2 fields/)).toBeInTheDocument();
  });

  it('does not render in basic mode', () => {
    render(AdvancedFieldsFixture, {
      props: { policy: makePolicy(), mode: 'basic' },
    });

    expect(screen.queryByText(/Advanced ·/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /Secret/ }),
    ).not.toBeInTheDocument();
  });

  it('uses singular "field" for one advanced field', async () => {
    const policy = makePolicy();
    // Remove one advanced field
    delete policy.fields.another;
    render(AdvancedFieldsFixture, {
      props: { policy, mode: 'advanced' },
    });
    await tick();

    expect(screen.getByText(/Advanced · 1 field$/)).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(AdvancedFieldsFixture, {
      props: { policy: makePolicy(), mode: 'advanced' },
    });
    await tick();
    await expectNoA11yViolations(container);
  });
});
