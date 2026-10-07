/**
 * Behaviour tests for CustomerSelect and VendorSelect (#3602): search, resolve
 * and create stay caller-owned; rows show the profile name with status and
 * type; the committed id (never the name) posts under the field name; the
 * field is accessible and localizable.
 */
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CustomerSelect from '../src/svelte/components/CustomerSelect.svelte';
import VendorSelect from '../src/svelte/components/VendorSelect.svelte';
import type {
  CustomerDisplayData,
  VendorDisplayData,
} from '../src/svelte/party-types.js';
import SelectFormFixture from './SelectFormFixture.svelte';

const CUSTOMERS: CustomerDisplayData[] = [
  {
    id: 'c1',
    profile: { name: 'Acme Corp' },
    status: 'active',
    customerType: 'wholesale',
  },
  { id: 'c2', profile: { name: 'Globex' }, status: 'suspended' },
  { id: 'c3', profile: { name: 'Initech' }, status: 'active', customerType: 'retail' },
];
const VENDORS: VendorDisplayData[] = [
  { id: 'v1', profile: { name: 'Northstar Supply' }, status: 'active' },
  { id: 'v2', profile: { name: 'Delta Freight' }, status: 'inactive' },
];

const byName = <T extends { profile: { name: string } }>(rows: T[], q: string) =>
  rows.filter((row) => row.profile.name.toLowerCase().includes(q.toLowerCase()));

function customerProps(extra: Record<string, unknown> = {}) {
  return {
    name: 'customerId',
    search: vi.fn(async (q: string) => byName(CUSTOMERS, q)),
    resolve: vi.fn(async (id: string) => CUSTOMERS.find((c) => c.id === id) ?? null),
    debounceMs: 5,
    ...extra,
  };
}

describe('CustomerSelect', () => {
  it('labels the combobox "Customer" by default and passes axe', async () => {
    const { container } = render(CustomerSelect, { props: customerProps() });
    expect(screen.getByRole('combobox', { name: 'Customer' })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('lists profile name with localized status and type, and passes axe open', async () => {
    const props = customerProps();
    const { container } = render(CustomerSelect, { props });
    await userEvent.click(screen.getByRole('combobox', { name: 'Customer' }));
    expect(await screen.findByRole('option', { name: /Acme Corp/ })).toHaveTextContent(
      'Active · Wholesale',
    );
    expect(screen.getByRole('option', { name: /Globex/ })).toHaveTextContent('Suspended');
    expect(props.search).toHaveBeenCalledWith('');
    await expectNoA11yViolations(container);
  });

  it('searches with the typed text and posts the id, not the name', async () => {
    const props = customerProps();
    render(SelectFormFixture, { props });
    const input = screen.getByRole('combobox', { name: 'Customer' });
    await userEvent.type(input, 'glo');
    await waitFor(() => expect(props.search).toHaveBeenLastCalledWith('glo'));
    await userEvent.click(await screen.findByRole('option', { name: /Globex/ }));
    const data = new FormData(screen.getByTestId('form') as HTMLFormElement);
    expect(data.get('customerId')).toBe('c2');
    expect(input).toHaveValue('Globex');
  });

  it('resolves the initial value to the profile name', async () => {
    const props = customerProps({ value: 'c3' });
    render(CustomerSelect, { props });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Initech'),
    );
    expect(props.resolve).toHaveBeenCalledWith('c3');
  });

  it('clears the selection', async () => {
    const onchange = vi.fn();
    render(CustomerSelect, { props: customerProps({ value: 'c1', onchange }) });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Acme Corp'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clear Customer' }));
    expect(onchange).toHaveBeenCalledWith('');
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('');
  });

  it('hides clear when required', async () => {
    render(CustomerSelect, { props: customerProps({ value: 'c1', required: true }) });
    expect(screen.queryByRole('button', { name: 'Clear Customer' })).toBeNull();
  });

  it('offers no new-customer action unless the caller supplies one', () => {
    render(CustomerSelect, { props: customerProps() });
    expect(screen.queryByRole('button', { name: /New customer/ })).toBeNull();
  });

  it('hands the searched text to onCreate and selects the created customer', async () => {
    const created: CustomerDisplayData = {
      id: 'c9',
      profile: { name: 'Umbrella' },
      status: 'active',
    };
    const onCreate = vi.fn(async () => created);
    const onchange = vi.fn();
    render(CustomerSelect, { props: customerProps({ onCreate, onchange }) });
    await userEvent.type(screen.getByRole('combobox', { name: 'Customer' }), 'umb');
    await userEvent.click(screen.getByRole('button', { name: '+ New customer' }));
    await waitFor(() => expect(onchange).toHaveBeenCalledWith('c9'));
    expect(onCreate).toHaveBeenCalledWith('umb');
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Umbrella');
  });

  it('keeps the caller-owned data out of the component: search failure shows status', async () => {
    const search = vi.fn(async () => {
      throw new Error('offline');
    });
    render(CustomerSelect, { props: customerProps({ search }) });
    await userEvent.click(screen.getByRole('combobox', { name: 'Customer' }));
    expect(await screen.findAllByText('Search failed. Try again.')).not.toHaveLength(0);
  });

  it('shows the empty state', async () => {
    render(CustomerSelect, { props: customerProps({ search: vi.fn(async () => []) }) });
    await userEvent.click(screen.getByRole('combobox', { name: 'Customer' }));
    expect((await screen.findAllByText('No matches')).length).toBeGreaterThan(0);
  });

  it('shows the validation error and links it to the field', async () => {
    const { container } = render(CustomerSelect, {
      props: customerProps({ error: 'Choose a customer.' }),
    });
    const input = screen.getByRole('combobox', { name: 'Customer' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Choose a customer.');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await expectNoA11yViolations(container);
  });

  it('localizes labels, actions and detail through the i18n catalog', async () => {
    render(SelectFormFixture, {
      props: { ...customerProps({ onCreate: vi.fn() }), german: true },
    });
    await userEvent.click(screen.getByRole('combobox', { name: 'Kunde' }));
    expect(await screen.findByRole('option', { name: /Acme Corp/ })).toHaveTextContent(
      'Aktiv · Großhandel',
    );
    expect(screen.getByRole('button', { name: '+ Neuer Kunde' })).toBeInTheDocument();
  });
});

describe('VendorSelect', () => {
  it('labels "Vendor", lists name and status, and passes axe', async () => {
    const search = vi.fn(async (q: string) => byName(VENDORS, q));
    const { container } = render(VendorSelect, { props: { name: 'vendorId', search, debounceMs: 5 } });
    await userEvent.click(screen.getByRole('combobox', { name: 'Vendor' }));
    expect(await screen.findByRole('option', { name: /Delta Freight/ })).toHaveTextContent(
      'Inactive',
    );
    expect(screen.getByRole('option', { name: /Northstar Supply/ })).not.toHaveTextContent('·');
    await expectNoA11yViolations(container);
  });

  it('resolves the current vendor and offers a new-vendor action', async () => {
    const resolve = vi.fn(async (id: string) => VENDORS.find((v) => v.id === id) ?? null);
    render(VendorSelect, {
      props: {
        name: 'vendorId',
        value: 'v1',
        search: async () => VENDORS,
        resolve,
        onCreate: vi.fn(),
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Vendor' })).toHaveValue('Northstar Supply'),
    );
    expect(screen.getByRole('button', { name: '+ New vendor' })).toBeInTheDocument();
  });
});
