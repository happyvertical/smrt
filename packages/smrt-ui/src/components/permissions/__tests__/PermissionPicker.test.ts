import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import PermissionPicker from '../PermissionPicker.svelte';
import PermissionPickerForm from './PermissionPickerForm.svelte';

const permissions = [
  {
    id: 'settings-read',
    slug: 'tenant.settings.read',
    name: 'Read settings',
    description: 'View workspace configuration.',
    category: 'Workspace',
  },
  {
    id: 'settings-manage',
    slug: 'tenant.settings.manage',
    name: 'Manage settings',
    category: 'Workspace',
  },
  {
    id: 'projects-read',
    slug: 'projects.read',
    description: 'View projects.',
  },
];

describe('PermissionPicker', () => {
  it('searches progressively while filtered checked fields remain successful controls', async () => {
    const user = userEvent.setup();
    const { container } = render(PermissionPickerForm, {
      props: {
        permissions,
        selected: ['tenant.settings.manage', 'projects.read'],
      },
    });
    const form = screen.getByRole('form', {
      name: 'Role grants',
    }) as HTMLFormElement;

    await user.type(
      screen.getByRole('searchbox', { name: 'Search permissions' }),
      'project',
    );
    expect(
      screen.getByText('Read settings').closest('.choice'),
    ).toHaveAttribute('hidden');
    expect(screen.getByText('Projects')).toBeVisible();
    expect(screen.getByText('Projects').closest('details')).toHaveAttribute(
      'open',
    );
    expect(new FormData(form).getAll('permission')).toEqual([
      'projects.read',
      'tenant.settings.manage',
    ]);

    await user.clear(screen.getByRole('searchbox'));
    expect(
      screen.getByText('Read settings').closest('.choice'),
    ).not.toHaveAttribute('hidden');
    expect(
      screen.getByText('Read settings').closest('details'),
    ).not.toHaveAttribute('open');
    await expectNoA11yViolations(container);
  });

  it('matches names, slugs, descriptions and categories and announces no results', async () => {
    const user = userEvent.setup();
    render(PermissionPicker, { props: { permissions } });
    const search = screen.getByRole('searchbox');

    await user.type(search, 'configuration');
    expect(screen.getByText('Read settings')).toBeVisible();
    expect(screen.getByText('Projects').closest('.group')).toHaveAttribute(
      'hidden',
    );
    await user.clear(search);
    await user.type(search, 'missing capability');
    expect(screen.getByRole('status')).toHaveTextContent(
      'No permissions match',
    );
  });

  it('keeps disabled selections readable, immutable and absent from FormData', async () => {
    const user = userEvent.setup();
    render(PermissionPickerForm, {
      props: { permissions, selected: ['projects.read'], disabled: true },
    });
    const form = screen.getByRole('form', {
      name: 'Role grants',
    }) as HTMLFormElement;
    const checkbox = screen.getByRole('checkbox', { name: 'Projects read' });

    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(new FormData(form).getAll('permission')).toEqual([]);
  });

  it('uses semantic fallback labels and does not create unknown selected controls', () => {
    const { container } = render(PermissionPickerForm, {
      props: {
        permissions: [{ slug: 'very_long-resource.permission_with_detail' }],
        selected: ['removed.permission'],
      },
    });
    expect(screen.getByText('Very long resource')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', {
        name: 'Very long resource permission with detail',
      }),
    ).not.toBeChecked();
    expect(container.querySelector('[value="removed.permission"]')).toBeNull();
  });

  it('reconciles native values to authoritative selections after a server retry rerender', async () => {
    const user = userEvent.setup();
    const { rerender } = render(PermissionPickerForm, {
      props: { permissions, selected: ['projects.read'] },
    });
    const form = screen.getByRole('form', {
      name: 'Role grants',
    }) as HTMLFormElement;
    const projects = screen.getByRole('checkbox', { name: 'Projects read' });
    const manage = screen.getByRole('checkbox', { name: 'Manage settings' });

    await user.click(projects);
    await user.click(manage);
    expect(screen.getByText('Workspace').closest('details')).toHaveTextContent(
      '1 selected',
    );
    await user.type(screen.getByRole('searchbox'), 'project');
    expect(new FormData(form).getAll('permission')).toEqual([
      'tenant.settings.manage',
    ]);

    await rerender({ permissions, selected: ['projects.read'] });
    expect(
      screen.getByRole('checkbox', { name: 'Projects read' }),
    ).toBeChecked();
    expect(
      form.querySelector<HTMLInputElement>('[value="tenant.settings.manage"]'),
    ).not.toBeChecked();
    expect(new FormData(form).getAll('permission')).toEqual(['projects.read']);
    expect(screen.getByText('Workspace').closest('details')).toHaveTextContent(
      '0 selected',
    );
  });

  it('keeps collapsed group counts synchronized with submitted native values', async () => {
    const user = userEvent.setup();
    render(PermissionPickerForm, { props: { permissions } });
    const form = screen.getByRole('form', {
      name: 'Role grants',
    }) as HTMLFormElement;
    const workspace = screen
      .getByText('Workspace')
      .closest('details') as HTMLDetailsElement;
    const workspaceSummary = screen
      .getByText('Workspace')
      .closest('summary') as HTMLElement;

    await user.click(workspaceSummary);
    await user.click(screen.getByRole('checkbox', { name: 'Manage settings' }));
    expect(workspace).toHaveTextContent('1 selected');
    expect(new FormData(form).getAll('permission')).toEqual([
      'tenant.settings.manage',
    ]);

    await user.type(screen.getByRole('searchbox'), 'project');
    expect(workspace).toHaveAttribute('hidden');
    expect(new FormData(form).getAll('permission')).toEqual([
      'tenant.settings.manage',
    ]);
    await user.clear(screen.getByRole('searchbox'));
    expect(workspace).not.toHaveAttribute('open');
    expect(workspace).toHaveTextContent('1 selected');

    await user.click(workspaceSummary);
    await user.click(screen.getByRole('checkbox', { name: 'Manage settings' }));
    expect(workspace).toHaveTextContent('0 selected');
    expect(new FormData(form).getAll('permission')).toEqual([]);
  });
});
