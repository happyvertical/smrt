// @vitest-environment jsdom
/**
 * Component tests for FieldPolicyProvider + PolicyField (#2048).
 *
 * Covers the acceptance criteria:
 * - PolicyField adoption with no layout change; unwrapped fields keep working
 * - Basic mode hides advanced-tier fields; disclosure reveals them
 * - Required-with-default fields prefill; loaded-record edits never overwritten
 * - Help hint renders from resolved help (manifest description → org override)
 * - Graceful degradation outside a Provider
 * - Snippet escape hatch
 * - a11y (axe-clean)
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
import FieldPolicyProvider from '../components/FieldPolicyProvider.svelte';
import PolicyField from '../components/PolicyField.svelte';
import DomPrefillFixture from './fixtures/DomPrefillFixture.svelte';
import GracefulDegradeFixture from './fixtures/GracefulDegradeFixture.svelte';
import PrefillFixture from './fixtures/PrefillFixture.svelte';
import ProviderFieldFixture from './fixtures/ProviderFieldFixture.svelte';
import RevealPrefillFixture from './fixtures/RevealPrefillFixture.svelte';
import SnippetFixture from './fixtures/SnippetFixture.svelte';
import TooltipFixture from './fixtures/TooltipFixture.svelte';

function makePolicy(
  overrides: Partial<ResolvedObjectFieldPolicy> = {},
): ResolvedObjectFieldPolicy {
  return {
    objectRef: '@test:Widget',
    fields: {
      name: {
        fieldName: 'name',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'basic',
        help: 'The widget name',
        label: 'Name',
        order: 1,
        group: null,
        locked: false,
        required: true,
      },
      sku: {
        fieldName: 'sku',
        hasDefault: true,
        defaultValue: 'WIDG-001',
        visibility: 'basic',
        help: null,
        label: 'SKU',
        order: 2,
        group: null,
        locked: false,
        required: false,
      },
      wholesalePrice: {
        fieldName: 'wholesalePrice',
        hasDefault: true,
        defaultValue: 0,
        visibility: 'advanced',
        help: 'Price for wholesale customers',
        label: 'Wholesale Price',
        order: 3,
        group: 'pricing',
        locked: false,
        required: false,
      },
      internalNotes: {
        fieldName: 'internalNotes',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'hidden',
        help: 'Internal only',
        label: 'Internal Notes',
        order: 4,
        group: null,
        locked: false,
        required: false,
      },
    },
    ...overrides,
  };
}

describe('FieldPolicyProvider + PolicyField', () => {
  it('renders basic fields in basic mode', () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });

    expect(screen.getByRole('textbox', { name: /Name/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /SKU/ })).toBeInTheDocument();
  });

  it('hides advanced fields in basic mode', () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });

    // wholesalePrice is type=number → role is spinbutton, not textbox
    expect(
      screen.queryByRole('spinbutton', { name: /Wholesale Price/ }),
    ).not.toBeInTheDocument();
  });

  it('reveals advanced fields in advanced mode', async () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'advanced' },
    });
    // Wait for the provider's mode-sync $effect to flush (the untrack() seed
    // reflects the requested mode on first paint, but $effect reactivity in
    // jsdom needs a tick for the DOM to settle).
    await tick();

    // wholesalePrice is type=number → role is spinbutton, not textbox
    expect(
      screen.getByRole('spinbutton', { name: /Wholesale Price/ }),
    ).toBeInTheDocument();
  });

  it('never renders hidden-tier fields', () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'advanced' },
    });

    expect(screen.queryByText('Internal Notes')).not.toBeInTheDocument();
  });

  it('renders help hint from resolved help text', () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });

    expect(screen.getByText('The widget name')).toBeInTheDocument();
  });

  it('renders required marker for required fields', () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });

    const nameField = screen.getByText('Name').closest('.policy-field');
    expect(nameField?.querySelector('.policy-field__required')).not.toBeNull();
  });

  it('does not render required marker for optional fields', () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });

    const skuField = screen.getByText('SKU').closest('.policy-field');
    expect(skuField?.querySelector('.policy-field__required')).toBeNull();
  });

  it('exposes default value via snippet props for prefill signal', () => {
    const policy = makePolicy();
    render(PrefillFixture, {
      props: { policy, mode: 'basic' },
    });

    // The fixture renders the default value text from snippet props
    expect(screen.getByText('Default: WIDG-001')).toBeInTheDocument();
  });

  it('degrades gracefully outside a Provider (renders children verbatim)', () => {
    render(GracefulDegradeFixture);

    // Should render the input even without a provider
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('snippet escape hatch receives resolved policy data', () => {
    const policy = makePolicy();
    render(SnippetFixture, {
      props: { policy, mode: 'basic' },
    });

    expect(screen.getByTestId('field-label')).toHaveTextContent('Name');
    expect(screen.getByTestId('field-help')).toHaveTextContent(
      'The widget name',
    );
    expect(screen.getByTestId('field-required')).toHaveTextContent('true');
  });

  it('helpDensity tooltip attaches help to the label title and hides the hint', () => {
    const policy = makePolicy();
    render(TooltipFixture, {
      props: { policy, helpDensity: 'tooltip' },
    });

    // Help moves to the label's title attribute
    const label = screen.getByText('Name').closest('label');
    expect(label).not.toBeNull();
    expect(label?.getAttribute('title')).toBe('The widget name');
    // The help text is no longer rendered as visible text content
    expect(screen.queryByText('The widget name')).not.toBeInTheDocument();
    // No visible hint paragraph
    expect(screen.queryByRole('paragraph')).not.toBeInTheDocument();
  });

  it('links the help hint to the input via aria-describedby', async () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });
    await tick();

    // `name` has resolved help rendered as the hint paragraph #name-help —
    // the input must reference it for screen readers.
    const input = screen.getByRole('textbox', { name: /Name/ });
    expect(input.getAttribute('aria-describedby')).toBe('name-help');
    expect(document.getElementById('name-help')).not.toBeNull();

    // `sku` has no resolved help → no hint id, no dangling aria reference.
    const skuInput = screen.getByRole('textbox', { name: /SKU/ });
    expect(skuInput.hasAttribute('aria-describedby')).toBe(false);
  });

  it('helpDensity tooltip falls back to a visible hint when there is no label', () => {
    // Policy with no resolved label → label === null → help must still render
    const policy = makePolicy({
      fields: {
        name: {
          fieldName: 'name',
          hasDefault: false,
          defaultValue: undefined,
          visibility: 'basic',
          help: 'Orphan help text',
          label: null,
          order: 1,
          group: null,
          locked: false,
          required: false,
        },
      },
    });
    render(TooltipFixture, {
      props: { policy, helpDensity: 'tooltip' },
    });

    expect(screen.getByText('Orphan help text')).toBeInTheDocument();
  });

  it('mode toggle reveals advanced fields', async () => {
    const policy = makePolicy();
    render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });

    // Advanced field not visible initially
    expect(
      screen.queryByRole('spinbutton', { name: /Wholesale/ }),
    ).not.toBeInTheDocument();

    // Toggle mode (the fixture's button calls modeStore.toggle() via context)
    await userEvent.click(screen.getByRole('button', { name: 'Toggle Mode' }));

    expect(
      screen.getByRole('spinbutton', { name: /Wholesale Price/ }),
    ).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const policy = makePolicy();
    const { container } = render(ProviderFieldFixture, {
      props: { policy, mode: 'basic' },
    });
    await expectNoA11yViolations(container);
  });
});

describe('PolicyField default prefill (new records only)', () => {
  it('prefills an empty input with the resolved default for a new record', async () => {
    const policy = makePolicy();
    render(DomPrefillFixture, {
      props: { policy, isNewRecord: true, skuValue: '' },
    });
    await tick();

    // The sku field has a resolved default of 'WIDG-001'; the empty input
    // should be prefilled with it.
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /SKU/,
    });
    expect(input.value).toBe('WIDG-001');
    // The bound state should pick up the prefilled value too
    expect(screen.getByTestId('sku-state')).toHaveTextContent('WIDG-001');
  });

  it('does NOT clobber a loaded record with an existing value', async () => {
    const policy = makePolicy();
    render(DomPrefillFixture, {
      props: { policy, isNewRecord: true, skuValue: 'EXISTING-999' },
    });
    await tick();

    // The input already has a value (loaded record); the default must NOT
    // overwrite it.
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /SKU/,
    });
    expect(input.value).toBe('EXISTING-999');
    expect(screen.getByTestId('sku-state')).toHaveTextContent('EXISTING-999');
  });

  it('does NOT prefill when isNewRecord is false', async () => {
    const policy = makePolicy();
    render(DomPrefillFixture, {
      props: { policy, isNewRecord: false, skuValue: '' },
    });
    await tick();

    // isNewRecord=false → no prefill even though the field is empty and has a
    // resolved default.
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /SKU/,
    });
    expect(input.value).toBe('');
  });
});

describe('PolicyField prefill on reveal (advanced-tier fields)', () => {
  it('prefills an advanced field when the mode switch reveals it', async () => {
    const policy = makePolicy();
    render(RevealPrefillFixture, {
      props: { policy, isNewRecord: true },
    });
    await tick();

    // Hidden in basic mode: no input to prefill yet.
    expect(
      screen.queryByRole('spinbutton', { name: /Wholesale Price/ }),
    ).not.toBeInTheDocument();

    // Reveal the advanced tier.
    await userEvent.click(screen.getByRole('button', { name: 'Toggle Mode' }));
    await tick();

    // wholesalePrice resolves default 0 — a legitimate integer default that
    // must survive the undefined/null guards.
    const input = screen.getByRole<HTMLInputElement>('spinbutton', {
      name: /Wholesale Price/,
    });
    expect(input.value).toBe('0');
    // The bound state picked up the prefilled value via the dispatched event.
    expect(screen.getByTestId('wholesale-state')).toHaveTextContent('0');
  });

  it('does NOT prefill a revealed advanced field when isNewRecord is false', async () => {
    const policy = makePolicy();
    render(RevealPrefillFixture, {
      props: { policy, isNewRecord: false },
    });
    await tick();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle Mode' }));
    await tick();

    const input = screen.getByRole<HTMLInputElement>('spinbutton', {
      name: /Wholesale Price/,
    });
    expect(input.value).toBe('');
  });

  it('prefills only once — a deliberately cleared input is never re-filled', async () => {
    const policy = makePolicy();
    render(RevealPrefillFixture, {
      props: { policy, isNewRecord: true },
    });
    await tick();

    // Reveal → prefill runs once.
    await userEvent.click(screen.getByRole('button', { name: 'Toggle Mode' }));
    await tick();
    const input = screen.getByRole<HTMLInputElement>('spinbutton', {
      name: /Wholesale Price/,
    });
    expect(input.value).toBe('0');

    // The user deliberately clears the field.
    await userEvent.clear(input);
    await tick();

    // Hide and reveal again: the one-shot guard must prevent a re-prefill.
    await userEvent.click(screen.getByRole('button', { name: 'Toggle Mode' }));
    await userEvent.click(screen.getByRole('button', { name: 'Toggle Mode' }));
    await tick();

    const revealed = screen.getByRole<HTMLInputElement>('spinbutton', {
      name: /Wholesale Price/,
    });
    expect(revealed.value).toBe('');
  });
});

describe('PolicyField standalone', () => {
  it('renders without a provider (no crash)', () => {
    render(PolicyField, {
      props: { name: 'test' },
      target: document.body,
    });

    // No label wrapping since no context, just children area
    // Should not throw
  });
});
