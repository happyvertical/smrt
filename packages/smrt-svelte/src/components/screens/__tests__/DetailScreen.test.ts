import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DetailScreen from '../DetailScreen.svelte';
import { taskDefinition, taskPolicy, taskRows } from './fixtures.js';

const record = {
  ...taskRows[0],
  notes: 'Remember the changelog',
  payload: { a: 1 },
  secretToken: 'do-not-show',
  reference: 'REF-1',
};

describe('DetailScreen', () => {
  it('shows basic fields, tucks advanced ones away, and never shows omitted or hidden ones', () => {
    const { container } = render(DetailScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record,
        locale: 'en-US',
      },
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Write docs' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Task name')).toBeInTheDocument();
    expect(screen.getByText('$1,250.50')).toBeInTheDocument();
    // advanced tier is behind the disclosure
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(
      within(details as HTMLElement).getByText('Remember the changelog'),
    ).toBeInTheDocument();
    expect(
      within(details as HTMLElement).getByText('Created at'),
    ).toBeInTheDocument();
    expect(screen.queryByText('do-not-show')).not.toBeInTheDocument();
    expect(screen.queryByText('REF-1')).not.toBeInTheDocument();
  });

  it('renders empty values as Not set', () => {
    render(DetailScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: taskRows[1],
      },
    });
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('wires back and edit, and confirms before delete', async () => {
    const onback = vi.fn();
    const onedit = vi.fn();
    const ondelete = vi.fn().mockResolvedValue(undefined);
    render(DetailScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record,
        onback,
        onedit,
        ondelete,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Back to tasks' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onback).toHaveBeenCalledOnce();
    expect(onedit).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(ondelete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' }),
    );
    await vi.waitFor(() => expect(ondelete).toHaveBeenCalledOnce());
  });

  it('only links http(s) urls and mailto addresses', () => {
    const definition = {
      objectRef: '@acme/x:Contact',
      className: 'Contact',
      fields: {
        name: { type: 'text' as const, ui: { basic: true } },
        site: {
          type: 'text' as const,
          ui: { basic: true, widget: 'url' as const },
        },
        mail: {
          type: 'text' as const,
          ui: { basic: true, widget: 'email' as const },
        },
      },
    };
    render(DetailScreen, {
      props: {
        definition,
        record: {
          name: 'Ada',
          site: 'javascript:alert(1)',
          mail: 'ada@example.com',
        },
      },
    });
    expect(screen.getByText('javascript:alert(1)').closest('a')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'ada@example.com' }),
    ).toHaveAttribute('href', 'mailto:ada@example.com');
  });

  it('renders reference fields as labelled links when hrefFor and labels are given', () => {
    const relations = [
      {
        model: '@acme/users:User',
        field: 'ownerId',
        label: 'Owner',
        kind: 'reference' as const,
      },
    ];
    const { rerender } = render(DetailScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record,
        relations,
        hrefFor: (field, id) =>
          field.name === 'ownerId' ? `/users/${id}` : undefined,
        labels: {
          '@acme/users:User': (id) =>
            id === record.ownerId ? 'Ada' : undefined,
        },
      },
    });
    expect(screen.getByRole('link', { name: 'Ada' })).toHaveAttribute(
      'href',
      `/users/${record.ownerId}`,
    );
    expect(document.querySelector('code')).toBeNull();

    // No href: the label still replaces the raw id. No label either: a short id in <code>.
    rerender({
      definition: taskDefinition,
      policy: taskPolicy,
      record,
      relations,
      hrefFor: undefined,
      labels: { '@acme/users:User': () => 'Ada' },
    });
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ada' })).toBeNull();
    rerender({
      definition: taskDefinition,
      policy: taskPolicy,
      record,
      relations,
      labels: undefined,
    });
    const code = document.querySelector('code');
    expect(code?.textContent).toBe('0b0c7b5e…');
    expect(code).toHaveAttribute('title', String(record.ownerId));

    // A link without a label shows the short id inside the link.
    rerender({
      definition: taskDefinition,
      policy: taskPolicy,
      record,
      relations,
      hrefFor: (_field, id) => `/users/${id}`,
      labels: undefined,
    });
    const link = screen.getByRole('link', { name: '0b0c7b5e…' });
    expect(link).toHaveAttribute('href', `/users/${record.ownerId}`);
    expect(link.querySelector('code')).not.toBeNull();
  });

  it('shows an empty JSON object as Not set and a filled one as a key/value list', () => {
    const { rerender, container } = render(DetailScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: { ...record, payload: {} },
      },
    });
    const field = () =>
      [...container.querySelectorAll('.smrt-detail-screen__field')].find(
        (el) => el.querySelector('dt')?.textContent === 'Payload',
      ) as HTMLElement;
    expect(within(field()).getByText('Not set')).toBeInTheDocument();
    expect(field().textContent).not.toContain('{}');

    rerender({
      definition: taskDefinition,
      policy: taskPolicy,
      record: { ...record, payload: { line1: '12 Main St', postalCode: '' } },
    });
    expect(within(field()).getByText('Line1')).toBeInTheDocument();
    expect(within(field()).getByText('12 Main St')).toBeInTheDocument();
    expect(within(field()).queryByText('Postal code')).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(DetailScreen, {
      props: { definition: taskDefinition, policy: taskPolicy, record },
    });
    await expectNoA11yViolations(container);
  });
});
