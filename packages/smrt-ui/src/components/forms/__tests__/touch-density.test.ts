import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollectionToolbar from '../../data/CollectionToolbar.svelte';
import DataTable from '../../data/DataTable.svelte';
import FilterChips from '../../nav/FilterChips.svelte';
import Button from '../../ui/Button.svelte';
import Pagination from '../../ui/Pagination.svelte';
import Checkbox from '../Checkbox.svelte';
import Input from '../Input.svelte';
import RadioGroup from '../RadioGroup.svelte';
import SegmentedControl from '../SegmentedControl.svelte';
import Select from '../Select.svelte';
import Switch from '../Switch.svelte';
import Textarea from '../Textarea.svelte';
import TouchDensityFixture from './touch-density.fixture.svelte';

describe('touch density', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });
  it.each([
    ['Input', Input, {}],
    [
      'RadioGroup',
      RadioGroup,
      {
        name: 'choice',
        children: createRawSnippet(() => ({
          render: () => '<span>Options</span>',
        })),
      },
    ],
    [
      'Select',
      Select,
      {
        children: createRawSnippet(() => ({
          render: () => '<option value="one">One</option>',
        })),
      },
    ],
    ['Textarea', Textarea, {}],
    ['Checkbox', Checkbox, {}],
    ['Switch', Switch, {}],
    ['Button', Button, {}],
    ['FilterChips', FilterChips, { options: [], selected: '' }],
    ['SegmentedControl', SegmentedControl, { options: [], label: 'Segments' }],
    ['DataTable', DataTable, { columns: [], data: [] }],
    ['Pagination', Pagination, { currentPage: 1, totalPages: 3 }],
    ['CollectionToolbar', CollectionToolbar, {}],
  ])('%s consumes density on its target root', (_name, component, props) => {
    const { container } = render(component as typeof Input, {
      props: { ...props, density: 'touch' },
    });
    expect(container.querySelector('[data-density="touch"]')).toBeTruthy();
    expect(container.querySelector('[density]')).toBeNull();
  });

  it.each([
    'touch',
    'comfortable',
  ] as const)('DataTable passes density=%s through to its pager', (density) => {
    const { container } = render(DataTable, {
      props: {
        columns: [{ id: 'title', label: 'Title' }],
        data: [
          { id: 'one', title: 'One' },
          { id: 'two', title: 'Two' },
        ],
        rowKey: 'id',
        pageSize: 1,
        density,
      },
    });
    expect(
      container.querySelector('nav[data-smrt-component="Pagination"]'),
    ).toHaveAttribute('data-density', density);
  });

  it('DataTable leaves its pager to inherit when density is omitted', () => {
    const { container } = render(DataTable, {
      props: {
        columns: [{ id: 'title', label: 'Title' }],
        data: [
          { id: 'one', title: 'One' },
          { id: 'two', title: 'Two' },
        ],
        rowKey: 'id',
        pageSize: 1,
      },
    });
    const pager = container.querySelector(
      'nav[data-smrt-component="Pagination"]',
    );
    expect(pager).toBeTruthy();
    expect(pager).not.toHaveAttribute('data-density');
  });

  it('inherits global density while preserving native size and local overrides', () => {
    const { container } = render(TouchDensityFixture);
    expect(container.querySelector('.smrt-theme-root')).toHaveAttribute(
      'style',
      expect.stringContaining(
        // No hex/px fallback: --smrt-touch-target-min is theme-required (#3826).
        '--smrt-control-target-min: var(--smrt-touch-target-min)',
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute(
      'size',
      '12',
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute(
      'data-density',
    );
    expect(
      screen.getByRole('textbox', { name: 'Local comfortable' }),
    ).toHaveAttribute('data-density', 'comfortable');
    expect(
      screen.getByRole('textbox', { name: 'Local touch' }),
    ).toHaveAttribute('data-density', 'touch');
  });

  // #3874: the toolbar's own search box and view switch take its density.
  it('CollectionToolbar passes density to its search input and view switch', () => {
    const { container } = render(CollectionToolbar, {
      props: { density: 'touch', views: ['list', 'table'] },
    });
    expect(
      container
        .querySelector('input[type="search"]')
        ?.getAttribute('data-density'),
    ).toBe('touch');
    expect(
      container
        .querySelector('[role="radiogroup"]')
        ?.getAttribute('data-density'),
    ).toBe('touch');
  });
});
