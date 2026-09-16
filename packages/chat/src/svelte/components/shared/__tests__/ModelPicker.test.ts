// @vitest-environment jsdom
/**
 * Component-level coverage for ModelPicker (#2904 review, cycle-3 second
 * final F2 — the underlying `<select>` had no accessible name, no test in
 * this suite ever supplied `models` to any component, and this file had no
 * test at all).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelPicker, { type ModelOption } from '../ModelPicker.svelte';

const models: ModelOption[] = [
  { id: 'model-a', label: 'Model A' },
  { id: 'model-b', label: 'Model B' },
];

describe('ModelPicker', () => {
  it('has an accessible name by default and lets the user pick a model', async () => {
    const onchange = vi.fn();
    render(ModelPicker, { props: { models, value: 'model-a', onchange } });

    const select = screen.getByLabelText('Model');
    expect(select).toBeInTheDocument();

    await userEvent.selectOptions(select, 'model-b');
    expect(onchange).toHaveBeenCalledWith('model-b');
  });

  it('accepts an override accessible name via ariaLabel', () => {
    render(ModelPicker, {
      props: { models, value: 'model-a', ariaLabel: 'Reply model' },
    });
    expect(screen.getByLabelText('Reply model')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ModelPicker, {
      props: { models, value: 'model-a' },
    });
    await expectNoA11yViolations(container);
  });
});
