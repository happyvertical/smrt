/**
 * Generated model forms render every field through these components, so they
 * must share one label treatment (plain label above the control), expose the
 * label as the control's accessible name even when a name is reused on the
 * page, show currency once, and offer a single empty select option.
 */
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    isInitializing: false,
    isReady: false,
    adapterType: null,
    downloadProgress: 0,
    lastResult: '',
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import DateTimeInput from '../DateTimeInput.svelte';
import MoneyInput from '../MoneyInput.svelte';
import NumberInput from '../NumberInput.svelte';
import PhoneInput from '../PhoneInput.svelte';
import SelectInput from '../SelectInput.svelte';
import TextareaInput from '../TextareaInput.svelte';
import TextInput from '../TextInput.svelte';

const STATUS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
];

describe('one label class across generated form fields', () => {
  it.each([
    ['TextInput', TextInput, {}],
    ['TextareaInput', TextareaInput, {}],
    ['SelectInput', SelectInput, { options: STATUS }],
    ['MoneyInput', MoneyInput, {}],
    ['DateTimeInput', DateTimeInput, {}],
    ['NumberInput', NumberInput, {}],
    ['PhoneInput', PhoneInput, {}],
  ] as const)('%s uses .smrt-field-label, never the themed .smrt-label', (_n, Component, extra) => {
    const { container } = render(Component as never, {
      props: { name: 'f', label: 'The label', ...extra },
    });
    const label = container.querySelector('label');
    expect(label).not.toBeNull();
    expect(label?.classList.contains('smrt-field-label')).toBe(true);
    expect(label?.classList.contains('smrt-label')).toBe(false);
    expect(label?.classList.contains('label')).toBe(false);
  });
});

describe('accessible names are the label, even with a repeated name', () => {
  it('select is named by its label, not its current value', () => {
    render(SelectInput, {
      props: {
        name: 'status',
        label: 'Status',
        options: STATUS,
        value: 'sent',
      },
    });
    expect(
      screen.getByRole('combobox', { name: 'Status' }),
    ).toBeInTheDocument();
  });

  it('money input is named by its label, not its placeholder', () => {
    render(MoneyInput, { props: { name: 'total', label: 'Total amount' } });
    expect(
      screen.getByRole('textbox', { name: 'Total amount' }),
    ).toBeInTheDocument();
  });

  it('a second control reusing the same name keeps its own label', () => {
    render(MoneyInput, { props: { name: 'dup', label: 'First amount' } });
    render(MoneyInput, { props: { name: 'dup', label: 'Second amount' } });
    expect(
      screen.getByRole('textbox', { name: 'First amount' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Second amount' }),
    ).toBeInTheDocument();
  });
});

describe('MoneyInput shows the currency once', () => {
  it('renders the code and no symbol prefix', () => {
    const { container } = render(MoneyInput, {
      props: { name: 'total', label: 'Total', currency: 'USD' },
    });
    expect(container.textContent).toContain('USD');
    expect(container.textContent).not.toContain('US$');
  });
});

describe('SelectInput has at most one empty option', () => {
  const empties = (container: HTMLElement) =>
    [...container.querySelectorAll('option')].filter((o) => o.value === '');

  it('shows the placeholder when no empty option is supplied', () => {
    const { container } = render(SelectInput, {
      props: { name: 's', label: 'S', options: STATUS },
    });
    expect(empties(container)).toHaveLength(1);
    expect(empties(container)[0].textContent).toBe('Select an option...');
  });

  it('lets a supplied empty option replace the placeholder', () => {
    const { container } = render(SelectInput, {
      props: {
        name: 's',
        label: 'S',
        options: [{ value: '', label: '(none)' }, ...STATUS],
      },
    });
    expect(empties(container)).toHaveLength(1);
    expect(empties(container)[0].textContent).toBe('(none)');
  });
});

describe('unified fields are axe-clean', () => {
  it('select, textarea, text, money and date together', async () => {
    const { container } = render(SelectInput, {
      props: { name: 'status', label: 'Status', options: STATUS },
    });
    await expectNoA11yViolations(container);
    for (const [Component, props] of [
      [TextInput, { name: 'ref', label: 'Reference' }],
      [TextareaInput, { name: 'notes', label: 'Notes' }],
      [MoneyInput, { name: 'total', label: 'Total amount' }],
      [DateTimeInput, { name: 'due', label: 'Due date', includeTime: false }],
    ] as const) {
      const r = render(Component as never, { props });
      await expectNoA11yViolations(r.container);
    }
  });
});

describe('no component defines its own field label style', () => {
  it('every label comes from the shared FieldLabel', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = `${process.cwd()}/src/components/forms/`;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.svelte'))
      .filter((f) => {
        const src = readFileSync(`${dir}${f}`, 'utf8');
        return (
          /\.smrt-field-label\s*\{/.test(src) ||
          /<label[^>]*smrt-field-label/.test(src)
        );
      });
    expect(offenders).toEqual([]);
  });
});
