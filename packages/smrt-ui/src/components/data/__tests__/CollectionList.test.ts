import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CollectionList from '../CollectionList.svelte';

const items = [
  { id: 'a', title: 'First' },
  { id: 'b', title: 'Second' },
];

describe('CollectionList', () => {
  it.each([
    'list',
    'divided',
    'grid',
    'gallery',
  ] as const)('renders the %s layout', (layout) => {
    const { container } = render(CollectionList, {
      props: { items, itemKey: 'id', title: 'title', layout },
    });
    expect(container.querySelector(`ul.collection--${layout}`)).not.toBeNull();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('selects an item with its labelled checkbox', async () => {
    const onselectionchange = vi.fn();
    render(CollectionList, {
      props: {
        items,
        itemKey: 'id',
        title: 'title',
        layout: 'gallery',
        selectable: true,
        onselectionchange,
      },
    });
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select Second' }),
    );
    expect(onselectionchange).toHaveBeenCalledWith(new Set(['b']));
  });
});
