import {
  type Component,
  type ComponentProps,
  flushSync,
  mount,
  unmount,
} from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeadCreateForm from '../components/LeadCreateForm.svelte';
import LeadDetail from '../components/LeadDetail.svelte';
import LeadList from '../components/LeadList.svelte';
import LeadDetailSummaryHarness from './LeadDetailSummaryHarness.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function render<T extends Component>(
  component: T,
  props: ComponentProps<T>,
): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function submit(target: HTMLElement): void {
  const form = target.querySelector('form');
  if (!form) throw new Error('Expected a form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
}

afterEach(() => {
  while (mounted.length) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('LeadCreateForm', () => {
  it('requires a name and email or phone, and validates an entered email', () => {
    const onSubmit = vi.fn();
    const target = render(LeadCreateForm, { onSubmit });
    const inputs = target.querySelectorAll('input');
    submit(target);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(target.textContent).toContain('Name is required.');
    setInput(inputs[0], 'Acme');
    submit(target);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(target.textContent).toContain(
      'Enter an email address or phone number.',
    );

    setInput(inputs[1], 'not-an-email');
    setInput(inputs[2], '555-0100');
    submit(target);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(target.textContent).toContain('Enter a valid email address.');
  });

  it('emits a trimmed draft with normalized email and selected host choices', () => {
    const onSubmit = vi.fn();
    const target = render(LeadCreateForm, {
      onSubmit,
      sourceOptions: [{ value: 'web', label: 'Website' }],
      reps: [{ id: 'rep-1', name: 'Alex' }],
    });
    const inputs = target.querySelectorAll('input');
    setInput(inputs[0], ' Acme ');
    setInput(inputs[1], ' SALES@ACME.COM ');
    const selects = target.querySelectorAll('select');
    selects[0].value = 'web';
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    selects[1].value = 'rep-1';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    submit(target);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Acme',
        email: 'sales@acme.com',
        sourceKind: 'web',
        ownerRepId: 'rep-1',
      }),
    );
  });

  it('accepts phone-only contact and invokes cancel', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const target = render(LeadCreateForm, { onSubmit, onCancel });
    const inputs = target.querySelectorAll('input');
    setInput(inputs[0], 'Delta');
    setInput(inputs[2], '555-0199');
    submit(target);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Delta',
        phone: '555-0199',
        email: undefined,
      }),
    );
    [...target.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Cancel')
      ?.click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows duplicate and host error feedback and disables mutations while busy', () => {
    const onSubmit = vi.fn();
    const target = render(LeadCreateForm, {
      error: 'Could not create lead',
      duplicate: { id: 'dup', name: 'Existing Acme', status: 'new' },
      busy: true,
      onSubmit,
    });
    expect(target.textContent).toContain('Possible duplicate: Existing Acme');
    expect(target.textContent).toContain('Could not create lead');
    expect(
      target.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    const nameInput = target.querySelector<HTMLInputElement>('input');
    const nameLabel = [...target.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Lead name'),
    );
    expect(nameInput?.id).toBeTruthy();
    expect(nameLabel?.htmlFor).toBe(nameInput?.id);
    const inputs = target.querySelectorAll('input');
    setInput(inputs[0], 'Acme');
    setInput(inputs[1], 'lead@acme.test');
    submit(target);
    expect(target.textContent).toContain('Could not create lead');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('LeadList inbox controls', () => {
  const leads = [
    {
      id: 'lead-1',
      name: 'Acme',
      status: 'new' as const,
      createdAt: '2026-09-01T00:00:00Z',
      receivedLabel: 'Received today',
    },
  ];

  it('emits controlled filter, sort, page and selection changes and shows counts', () => {
    const onStatusFilterChange = vi.fn();
    const onSortChange = vi.fn();
    const onPageChange = vi.fn();
    const onSelect = vi.fn();
    const target = render(LeadList, {
      leads,
      total: 60,
      page: 2,
      pageSize: 25,
      statusCounts: { new: 4, unassigned: 2, overdue: 1 },
      onStatusFilterChange,
      onSortChange,
      onPageChange,
      onSelect,
    });
    expect(target.textContent).toContain('New4');
    expect(target.textContent).toContain('Unassigned2');
    expect(target.textContent).toContain('Overdue1');
    target.querySelector<HTMLButtonElement>('button')?.click();
    expect(onStatusFilterChange).toHaveBeenCalledWith('all');
    const sort = target.querySelector<HTMLSelectElement>('select');
    if (!sort) throw new Error('Expected sort select');
    sort.value = 'name';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    target.querySelector<HTMLButtonElement>('button.select-lead')?.click();
    const pagination = [...target.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Next'),
    );
    pagination?.click();
    expect(onSortChange).toHaveBeenCalledWith('name');
    expect(onSelect).toHaveBeenCalledWith('lead-1');
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('disables workflow actions while busy and wires row actions by lead id', () => {
    const onStartWorking = vi.fn();
    const onDisqualify = vi.fn();
    const target = render(LeadList, {
      leads: [{ id: 'lead-2', name: 'Beta', status: 'new' }],
      busy: false,
      onStartWorking,
      onDisqualify,
    });
    [...target.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Start')
      ?.click();
    [...target.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Disqualify')
      ?.click();
    flushSync();
    expect(onStartWorking).toHaveBeenCalledWith('lead-2');
    expect(onDisqualify).toHaveBeenCalledWith('lead-2');

    const busyTarget = render(LeadList, {
      leads: [{ id: 'lead-3', name: 'Gamma', status: 'new' }],
      busy: true,
      onStartWorking,
      onDisqualify,
    });
    const busyActions = [...busyTarget.querySelectorAll('button')].filter(
      (button) =>
        ['Start', 'Disqualify'].includes(button.textContent?.trim() ?? ''),
    );
    expect(busyActions).toHaveLength(2);
    expect(
      busyActions.every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    busyActions.forEach((button) => {
      button.click();
    });
    flushSync();
    expect(onStartWorking).toHaveBeenCalledTimes(1);
    expect(onDisqualify).toHaveBeenCalledTimes(1);

    const mergedTarget = render(LeadList, {
      leads: [
        {
          id: 'lead-4',
          name: 'Merged',
          status: 'merged',
          mergedIntoId: 'survivor',
        },
      ],
      onStartWorking,
      onDisqualify,
    });
    expect(
      [...mergedTarget.querySelectorAll('button')].some((button) =>
        ['Start', 'Disqualify'].includes(button.textContent?.trim() ?? ''),
      ),
    ).toBe(false);
  });

  it('renders the host href and selected state for the active lead', () => {
    const onSelect = vi.fn();
    const target = render(LeadList, {
      leads,
      selectedLeadId: 'lead-1',
      hrefForLead: (id) => `/leads/${id}`,
      onSelect,
    });
    const link = target.querySelector<HTMLAnchorElement>(
      'a[href="/leads/lead-1"]',
    );
    expect(link?.getAttribute('aria-current')).toBe('page');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('LeadDetail linked opportunity and reopen', () => {
  it('renders the linked opportunity and allows reopening a disqualified lead', () => {
    const onStartWorking = vi.fn();
    const target = render(LeadDetail, {
      lead: { id: 'lead-3', name: 'Gamma', status: 'disqualified' },
      opportunity: {
        id: 'opp-1',
        name: 'Gamma renewal',
        status: 'open',
        stageName: 'Discovery',
        href: '/opportunities/opp-1',
      },
      onStartWorking,
    });
    expect(target.textContent).toContain('Gamma renewal');
    expect(
      target.querySelector('a[href="/opportunities/opp-1"]'),
    ).not.toBeNull();
    [...target.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Reopen follow-up'))
      ?.click();
    expect(onStartWorking).toHaveBeenCalledWith('lead-3');
  });

  it('disables reopen while the host is busy', () => {
    const target = render(LeadDetail, {
      lead: { id: 'lead-4', name: 'Delta', status: 'disqualified' },
      busy: true,
      onStartWorking: vi.fn(),
    });
    expect(
      [...target.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Reopen'),
      )?.disabled,
    ).toBe(true);
  });

  it('renders a host supplied linked-opportunity summary snippet', () => {
    const target = render(LeadDetailSummaryHarness, {
      opportunity: {
        id: 'opp-slot',
        name: 'Slot opportunity',
        status: 'open',
        stageName: 'Review',
      },
    });
    expect(
      target.querySelector('[data-testid="host-opportunity-summary"]')
        ?.textContent,
    ).toContain('Slot opportunity (Review)');
  });
});
