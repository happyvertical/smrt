import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataTable from '../../data/DataTable.svelte';
import FilterChips from '../../nav/FilterChips.svelte';
import Button from '../../ui/Button.svelte';
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
  ])('%s consumes density on its target root', (_name, component, props) => {
    const { container } = render(component as typeof Input, {
      props: { ...props, density: 'touch' },
    });
    expect(container.querySelector('[data-density="touch"]')).toBeTruthy();
    expect(container.querySelector('[density]')).toBeNull();
  });

  it('inherits global density while preserving native size and local overrides', () => {
    const { container } = render(TouchDensityFixture);
    expect(container.querySelector('.smrt-theme-root')).toHaveAttribute(
      'style',
      expect.stringContaining(
        '--smrt-control-target-min: var(--smrt-touch-target-min, 48px)',
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
});
