// @vitest-environment jsdom
/**
 * Component tests for FormHelp (#2048).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import type { ResolvedObjectFieldPolicy } from '../../types.js';
import FieldPolicyProvider from '../components/FieldPolicyProvider.svelte';
import FormHelp from '../components/FormHelp.svelte';
import FormHelpFixture from './fixtures/FormHelpFixture.svelte';

function makePolicy(): ResolvedObjectFieldPolicy {
  return {
    objectRef: '@test:Widget',
    fields: {
      name: {
        fieldName: 'name',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'basic',
        help: 'The display name for this widget',
        label: 'Name',
        order: 2,
        group: null,
        locked: false,
        required: true,
      },
      sku: {
        fieldName: 'sku',
        hasDefault: true,
        defaultValue: 'W-001',
        visibility: 'basic',
        help: 'Stock keeping unit code',
        label: 'SKU',
        order: 1,
        group: null,
        locked: false,
        required: false,
      },
      wholesalePrice: {
        fieldName: 'wholesalePrice',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'advanced',
        help: 'Price for wholesale customers',
        label: 'Wholesale Price',
        order: 4,
        group: null,
        locked: false,
        required: false,
      },
      hidden: {
        fieldName: 'hidden',
        hasDefault: false,
        defaultValue: undefined,
        visibility: 'hidden',
        help: 'Should not appear in glossary',
        label: 'Hidden',
        order: 3,
        group: null,
        locked: false,
        required: false,
      },
    },
  };
}

describe('FormHelp', () => {
  it('renders a help toggle button', () => {
    render(FormHelpFixture, {
      props: { policy: makePolicy() },
    });

    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('shows glossary entries when expanded', async () => {
    render(FormHelpFixture, {
      props: { policy: makePolicy() },
    });

    // Open the help panel
    await userEvent.click(screen.getByText('Help'));

    expect(
      screen.getByText('The display name for this widget'),
    ).toBeInTheDocument();
    expect(screen.getByText('Stock keeping unit code')).toBeInTheDocument();
  });

  it('excludes hidden-tier fields from the glossary', async () => {
    render(FormHelpFixture, {
      props: { policy: makePolicy() },
    });

    await userEvent.click(screen.getByText('Help'));

    expect(
      screen.queryByText('Should not appear in glossary'),
    ).not.toBeInTheDocument();
  });

  it('excludes advanced-tier fields from the glossary in basic mode', async () => {
    // The glossary mirrors PolicyField visibility: advanced-tier fields are
    // not visible in basic mode, so their help must not be listed either.
    render(FormHelpFixture, {
      props: { policy: makePolicy(), mode: 'basic' },
    });

    await userEvent.click(screen.getByText('Help'));

    expect(
      screen.queryByText('Price for wholesale customers'),
    ).not.toBeInTheDocument();
    // Basic-tier entries still present.
    expect(
      screen.getByText('The display name for this widget'),
    ).toBeInTheDocument();
  });

  it('includes advanced-tier fields in the glossary in advanced mode', async () => {
    render(FormHelpFixture, {
      props: { policy: makePolicy(), mode: 'advanced' },
    });

    await userEvent.click(screen.getByText('Help'));

    expect(
      screen.getByText('Price for wholesale customers'),
    ).toBeInTheDocument();
  });

  it('shows object description when provided', async () => {
    render(FormHelpFixture, {
      props: {
        policy: makePolicy(),
        objectDescription: 'A widget is a configurable thing.',
      },
    });

    await userEvent.click(screen.getByText('Help'));

    expect(
      screen.getByText('A widget is a configurable thing.'),
    ).toBeInTheDocument();
  });

  it('orders glossary by resolved order (SKU before Name)', async () => {
    render(FormHelpFixture, {
      props: { policy: makePolicy() },
    });

    await userEvent.click(screen.getByText('Help'));

    const terms = screen.getAllByRole('term');
    expect(terms[0]).toHaveTextContent('SKU');
    expect(terms[1]).toHaveTextContent('Name');
  });

  it('is axe-clean', async () => {
    const { container } = render(FormHelpFixture, {
      props: { policy: makePolicy() },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean when expanded', async () => {
    const { container } = render(FormHelpFixture, {
      props: { policy: makePolicy() },
    });
    await userEvent.click(screen.getByText('Help'));
    await expectNoA11yViolations(container);
  });
});
