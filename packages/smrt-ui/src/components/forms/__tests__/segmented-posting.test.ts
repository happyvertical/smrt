import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Fixture from './segmented-posting.fixture.svelte';

function form(container: HTMLElement) {
  return container.querySelector('form') as HTMLFormElement;
}

describe('SegmentedControl native forms', () => {
  it('posts selected values and preserves numeric zero in bindings', async () => {
    const { container } = render(Fixture);
    expect(new FormData(form(container)).get('kind')).toBe('one');
    await userEvent.click(screen.getByRole('radio', { name: 'Zero' }));
    expect(new FormData(form(container)).get('kind')).toBe('0');
    expect(container.querySelector('[data-bound-value]')).toHaveTextContent(
      '0',
    );
  });
  it.each([
    { disabled: true },
    { outerDisabled: true },
    { initial: 'off' },
    { initial: 'missing' },
    { named: false },
  ])('omits disabled, unmatched, or unnamed values %j', (props) => {
    const { container } = render(Fixture, { props });
    expect(new FormData(form(container)).has('kind')).toBe(false);
  });
  it('requires an enabled selection including zero', async () => {
    const { container } = render(Fixture, {
      props: { required: true, initial: 'missing' },
    });
    expect(form(container).checkValidity()).toBe(false);
    await userEvent.click(screen.getByRole('radio', { name: 'Zero' }));
    expect(form(container).checkValidity()).toBe(true);
  });
  it('validates required unnamed controls without posting a generated field', async () => {
    const { container } = render(Fixture, {
      props: { required: true, named: false, initial: 'missing' },
    });
    expect(form(container).checkValidity()).toBe(false);
    await userEvent.click(screen.getByRole('radio', { name: 'Zero' }));
    expect(form(container).checkValidity()).toBe(true);
    expect([...new FormData(form(container)).keys()]).toEqual([]);
  });
  it('resets to the initial selection and binding and honors reset cancellation', async () => {
    const { container } = render(Fixture);
    await userEvent.click(screen.getByRole('radio', { name: 'Zero' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() =>
      expect(new FormData(form(container)).get('kind')).toBe('one'),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-bound-value]')).toHaveTextContent(
        'one',
      ),
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Zero' }));
    form(container).addEventListener('reset', (e) => e.preventDefault());
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(new FormData(form(container)).get('kind')).toBe('0');
  });
  it('resets a numeric initial value and clears unmatched initial values', async () => {
    const { container, unmount } = render(Fixture, { props: { initial: 0 } });
    await userEvent.click(screen.getByRole('radio', { name: 'One' }));
    form(container).reset();
    await waitFor(() =>
      expect(container.querySelector('[data-bound-value]')).toHaveTextContent(
        '0',
      ),
    );
    expect(container.querySelector('[data-bound-value]')).toHaveAttribute(
      'data-bound-type',
      'number',
    );
    unmount();
    const second = render(Fixture, {
      props: { initial: 'missing', required: true },
    });
    await userEvent.click(screen.getByRole('radio', { name: 'One' }));
    form(second.container).reset();
    await waitFor(() =>
      expect(
        second.container.querySelector('[data-bound-value]'),
      ).toHaveTextContent('undefined'),
    );
    expect(form(second.container).checkValidity()).toBe(false);
    expect(new FormData(form(second.container)).has('kind')).toBe(false);
  });
  it('emits one native change and one value callback per pointer selection', async () => {
    const onvaluechange = vi.fn();
    const { container } = render(Fixture, { props: { onvaluechange } });
    const onchange = vi.fn();
    form(container).addEventListener('change', onchange);
    await userEvent.click(screen.getByRole('radio', { name: 'Zero' }));
    expect(onvaluechange).toHaveBeenCalledExactlyOnceWith(0);
    expect(onchange).toHaveBeenCalledTimes(1);
  });
  it('supports arrow/home/end navigation while skipping disabled options', async () => {
    render(Fixture);
    const one = screen.getByRole('radio', { name: 'One' });
    one.focus();
    await fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Zero' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Zero' })).toHaveFocus();
    await fireEvent.keyDown(screen.getByRole('radio', { name: 'Zero' }), {
      key: 'Home',
    });
    expect(one).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Disabled' })).toBeDisabled();
  });
});
