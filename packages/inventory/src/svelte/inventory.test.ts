// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  AdjustStockForm,
  LocationForm,
  LocationList,
  MovementHistory,
  StockLevels,
} from './index.js';

describe('inventory components', () => {
  it('filters stock by location and marks only available stock below threshold', async () => {
    const { container } = render(StockLevels, {
      props: {
        locationId: 'warehouse',
        levels: [
          {
            skuId: 'low',
            locationId: 'warehouse',
            state: 'available',
            qty: 2,
            reorderPoint: 3,
          },
          {
            skuId: 'equal',
            locationId: 'warehouse',
            state: 'available',
            qty: 3,
            reorderPoint: 3,
          },
          {
            skuId: 'held',
            locationId: 'warehouse',
            state: 'allocated',
            qty: 0,
            reorderPoint: 3,
          },
          {
            skuId: 'other',
            locationId: 'store',
            state: 'available',
            qty: 0,
            reorderPoint: 3,
          },
        ],
      },
    });
    expect(screen.getAllByText('Low stock')).toHaveLength(1);
    expect(screen.queryByText('other')).toBeNull();
    await expectNoA11yViolations(container);
  });
  it('renders append-only movement attribution and open reason codes', () => {
    render(MovementHistory, {
      props: {
        movements: [
          {
            skuId: 'sku',
            locationId: 'warehouse',
            qty: 2,
            reasonCode: 'custom-count',
            actorProfileId: 'profile',
            sourceType: 'Count',
            sourceId: '123',
            note: 'Counted twice',
          },
        ],
      },
    });
    expect(screen.getByText('profile')).toBeTruthy();
    expect(screen.getByText('custom-count')).toBeTruthy();
    expect(screen.getByText('Count 123')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows empty states', () => {
    render(StockLevels, { props: { levels: [] } });
    render(MovementHistory, { props: { movements: [] } });
    render(LocationList, { props: { locations: [] } });
    expect(screen.getByText('No stock levels')).toBeTruthy();
    expect(screen.getByText('No stock movements')).toBeTruthy();
    expect(screen.getByText('No inventory locations')).toBeTruthy();
  });
  it('shows inactive locations and sends the selected record to edit', async () => {
    const location = {
      id: 'loc',
      code: 'WH',
      name: 'Warehouse',
      kind: 'custom-kind',
      active: false,
    };
    const onedit = vi.fn();
    render(LocationList, { props: { locations: [location], onedit } });
    expect(screen.getByText('Inactive')).toBeTruthy();
    expect(screen.getByText('custom-kind')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit WH' }));
    expect(onedit).toHaveBeenCalledWith(location);
  });
  it('rejects zero adjustment, sends signed values, and shows server failure', async () => {
    const onsubmit = vi.fn().mockRejectedValue(new Error('Insufficient stock'));
    const { container } = render(AdjustStockForm, {
      props: { skuId: 'sku', locationId: 'loc', onsubmit },
    });
    const quantity = screen.getByLabelText('Quantity adjustment');
    await userEvent.type(quantity, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust stock' }));
    expect(onsubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('non-zero');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '-2.5');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust stock' }));
    expect(onsubmit).toHaveBeenCalledWith({
      skuId: 'sku',
      locationId: 'loc',
      delta: -2.5,
      reasonCode: 'adjustment',
      note: '',
    });
    expect(screen.getByRole('alert').textContent).toBe('Insufficient stock');
    await expectNoA11yViolations(container);
  });
  it('blocks duplicate adjustments until the callback settles', async () => {
    let finish!: () => void;
    const onsubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(AdjustStockForm, {
      props: { skuId: 'sku', locationId: 'loc', onsubmit },
    });
    await userEvent.type(screen.getByLabelText('Quantity adjustment'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust stock' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(onsubmit).toHaveBeenCalledTimes(1);
    finish();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Stock adjusted',
    );
  });
  it('edits and deactivates a location without changing its identity', async () => {
    const onsubmit = vi.fn();
    const { container } = render(LocationForm, {
      props: {
        location: {
          id: 'loc',
          code: 'WH',
          name: 'Warehouse',
          kind: 'warehouse',
          active: true,
        },
        onsubmit,
      },
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Save location' }),
    );
    expect(onsubmit).toHaveBeenCalledWith({
      id: 'loc',
      code: 'WH',
      name: 'Warehouse',
      kind: 'warehouse',
      placeId: '',
      active: false,
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Location saved',
    );
    await expectNoA11yViolations(container);
  });
  it('creates locations, rejects blank required fields, and displays callback errors', async () => {
    const onsubmit = vi
      .fn()
      .mockRejectedValue(new Error('Code already exists'));
    render(LocationForm, { props: { onsubmit } });
    await userEvent.type(screen.getByLabelText('Code'), '  ');
    await userEvent.type(screen.getByLabelText('Name'), 'Warehouse');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save location' }),
    );
    expect(onsubmit).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Code'));
    await userEvent.type(screen.getByLabelText('Code'), 'NEW');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save location' }),
    );
    expect(onsubmit).toHaveBeenCalledWith({
      id: undefined,
      code: 'NEW',
      name: 'Warehouse',
      kind: 'warehouse',
      placeId: '',
      active: true,
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Code already exists');
  });
});
