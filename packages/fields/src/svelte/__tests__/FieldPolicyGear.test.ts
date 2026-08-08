// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import type { FieldPolicyEditorState } from '../../types.js';
import FieldPolicyEditor from '../components/FieldPolicyEditor.svelte';
import {
  editorStateErrorMessage,
  type FieldPolicyEditorAdapter,
  isFieldPolicyEditorState,
  mutationFromDraft,
  registerFieldPolicyFocusTool,
  requiredVisibilityIsInvalid,
  serializeDefaultValue,
} from '../field-policy-editor.js';

const fields = {
  title: { type: 'text', required: true },
  enabled: { type: 'boolean' },
};

function stateFor(
  capabilities: { manage: boolean; personalize: boolean } = {
    manage: true,
    personalize: true,
  },
): FieldPolicyEditorState {
  return {
    capabilities,
    personalLowerDefaultUsable: { title: false, enabled: false },
    policy: {
      objectRef: '@test:Widget',
      fields: {
        title: {
          fieldName: 'title',
          hasDefault: false,
          defaultValue: undefined,
          visibility: 'basic',
          help: null,
          label: 'Title',
          order: 1,
          group: null,
          locked: false,
          required: true,
        },
        enabled: {
          fieldName: 'enabled',
          hasDefault: true,
          defaultValue: false,
          visibility: 'basic',
          help: null,
          label: 'Enabled',
          order: 2,
          group: null,
          locked: true,
          required: false,
        },
      },
      layers: { title: [], enabled: [] },
    },
    rows: { app: [], tenant: [], user: [] },
  };
}

function adapter(): FieldPolicyEditorAdapter {
  return {
    load: async () => stateFor(),
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  };
}

/** Small round-trip transport double: tenant rows are shared, user rows aren't. */
class InMemoryPolicyTransport {
  organization: ReturnType<typeof mutationFromDraft> | null = null;
  personal = new Map<string, ReturnType<typeof mutationFromDraft>>();

  forUser(
    userId: string,
    capabilities = { manage: true, personalize: true },
  ): FieldPolicyEditorAdapter {
    return {
      load: async () => {
        if (!capabilities.manage && !capabilities.personalize) {
          return {
            ok: false as const,
            code: 'permission_denied' as const,
            status: 403 as const,
            message: 'Permission denied',
          };
        }
        const base = stateFor(capabilities);
        const own = this.personal.get(userId);
        const resolved = own ?? this.organization;
        if (resolved) {
          base.policy.fields.title.label =
            resolved.label ?? base.policy.fields.title.label;
          base.policy.fields.title.visibility =
            resolved.visibility ?? base.policy.fields.title.visibility;
        }
        return base;
      },
      create: async (mutation) => {
        if (mutation.scopeType === 'user') {
          if (this.organization?.locked)
            throw new Error('locked by organization');
          this.personal.set(userId, mutation);
        } else this.organization = mutation;
      },
      update: async (mutation) => {
        if (mutation.scopeType === 'user') {
          if (this.organization?.locked)
            throw new Error('locked by organization');
          this.personal.set(userId, mutation);
        } else this.organization = mutation;
      },
      delete: async ({ id }) => {
        if (id === `user:${userId}`) this.personal.delete(userId);
        if (id === 'organization') this.organization = null;
      },
    };
  }
}

describe('FieldPolicy gear', () => {
  it('keeps mutation identities context-derived and JSON encodes defaults', () => {
    expect(
      mutationFromDraft('@test:Widget', 'title', 'user', {
        defaultEnabled: true,
        defaultValue: 'Hello',
        displayOrder: null,
        help: null,
        label: null,
        locked: true,
        visibility: 'basic',
      }),
    ).toEqual({
      objectRef: '@test:Widget',
      fieldName: 'title',
      scopeType: 'user',
      defaultValue: '"Hello"',
      displayOrder: null,
      help: null,
      label: null,
      locked: null,
      visibility: 'basic',
    });
  });

  it('fails closed for missing or non-serializable explicit defaults, but keeps JSON null', () => {
    expect(() => serializeDefaultValue(undefined)).toThrow(/Choose a default/);
    expect(() => serializeDefaultValue(BigInt(1))).toThrow(/JSON-serializable/);
    expect(serializeDefaultValue(null)).toBe('null');
  });

  it('rejects a well-shaped editor response for a different object', () => {
    expect(isFieldPolicyEditorState(stateFor(), '@test:Other')).toBe(false);
    expect(isFieldPolicyEditorState(stateFor(), '@test:Widget')).toBe(true);
  });

  it('fails closed when the personal lower-default signal is absent or malformed', () => {
    const missing = stateFor() as Partial<FieldPolicyEditorState>;
    delete missing.personalLowerDefaultUsable;
    expect(isFieldPolicyEditorState(missing)).toBe(false);

    const malformed = stateFor();
    (malformed.personalLowerDefaultUsable as Record<string, unknown>).title =
      'yes';
    expect(isFieldPolicyEditorState(malformed)).toBe(false);
  });

  it('guards required no-default demotion before transport', () => {
    expect(requiredVisibilityIsInvalid(true, 'hidden', undefined)).toBe(true);
    expect(requiredVisibilityIsInvalid(true, 'advanced', 'seed')).toBe(false);
  });

  it('round-trips shared organization, isolated personal, lock, and reset semantics', async () => {
    const transport = new InMemoryPolicyTransport();
    const alice = transport.forUser('alice');
    const bob = transport.forUser('bob');
    const organization = mutationFromDraft('@test:Widget', 'title', 'tenant', {
      defaultEnabled: false,
      defaultValue: undefined,
      displayOrder: null,
      help: null,
      label: 'Organization title',
      locked: false,
      visibility: 'advanced',
    });
    await alice.create(organization);
    expect(
      ((await alice.load()) as FieldPolicyEditorState).policy.fields.title
        .label,
    ).toBe('Organization title');
    expect(
      ((await bob.load()) as FieldPolicyEditorState).policy.fields.title
        .visibility,
    ).toBe('advanced');

    const personal = {
      ...organization,
      scopeType: 'user' as const,
      label: 'Alice title',
    };
    await alice.create(personal);
    expect(
      ((await alice.load()) as FieldPolicyEditorState).policy.fields.title
        .label,
    ).toBe('Alice title');
    expect(
      ((await bob.load()) as FieldPolicyEditorState).policy.fields.title.label,
    ).toBe('Organization title');
    await alice.delete({ id: 'user:alice' });
    expect(
      ((await alice.load()) as FieldPolicyEditorState).policy.fields.title
        .label,
    ).toBe('Organization title');

    await alice.update({ ...organization, id: 'organization', locked: true });
    await expect(bob.create(personal)).rejects.toThrow(
      /locked by organization/,
    );
    await expect(
      transport.forUser('nobody', { manage: false, personalize: false }).load(),
    ).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it('registers a structural AdminShell focus tool and returns its disposer', () => {
    let captured: unknown;
    let disposed = false;
    const component = (() => null) as never;
    const render = (() => undefined) as never;
    const dispose = registerFieldPolicyFocusTool(
      {
        registerFocusTool(tool) {
          captured = tool;
          return () => {
            disposed = true;
          };
        },
      },
      '@test:Widget',
      { id: 'widget-settings', label: 'Field settings', component, render },
    );
    expect(captured).toMatchObject({
      subject: { type: 'object-form', id: '@test:Widget' },
      component,
      render,
    });
    dispose();
    expect(disposed).toBe(true);
  });

  it('fails closed when a generated custom-action response is malformed', () => {
    expect(editorStateErrorMessage({})).toBe('Unable to load field settings.');
  });

  it('links scope tabs to their panel and activates them with roving keyboard navigation', async () => {
    render(FieldPolicyEditor, {
      props: {
        state: stateFor(),
        adapter: adapter(),
        fields,
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    const organization = screen.getByRole('tab', { name: 'Organization' });
    const personal = screen.getByRole('tab', { name: 'Just me' });
    const panel = screen.getByRole('tabpanel');

    expect(organization).toHaveAttribute('aria-selected', 'true');
    expect(organization).toHaveAttribute('tabindex', '0');
    expect(personal).toHaveAttribute('aria-selected', 'false');
    expect(personal).toHaveAttribute('tabindex', '-1');
    expect(organization).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', organization.id);

    organization.focus();
    await userEvent.keyboard('{ArrowRight}');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(personal).toHaveFocus();
    expect(personal).toHaveAttribute('aria-selected', 'true');
    expect(personal).toHaveAttribute('tabindex', '0');
    expect(organization).toHaveAttribute('tabindex', '-1');
    expect(personal).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', personal.id);

    await userEvent.keyboard('{Home}');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(organization).toHaveFocus();
    await userEvent.keyboard('{End}');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(personal).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(organization).toHaveFocus();
  });

  it('permission-gates tabs, disables locked personal fields, and is axe-clean', async () => {
    const { container } = render(FieldPolicyEditor, {
      props: {
        state: stateFor({ manage: false, personalize: true }),
        adapter: adapter(),
        fields,
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    expect(screen.queryByRole('tab', { name: 'Organization' })).toBeNull();
    const personal = screen.getByRole('tab', { name: 'Just me' });
    const panel = screen.getByRole('tabpanel');
    expect(personal).toBeInTheDocument();
    expect(personal).toHaveAttribute('aria-selected', 'true');
    expect(personal).toHaveAttribute('tabindex', '0');
    expect(personal).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', personal.id);
    personal.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowRight}{Home}{End}');
    expect(personal).toHaveFocus();
    expect(
      screen.getByText(/locked by your organization/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[1],
    ).toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it('keeps a manage-only scope tab linked and selected', async () => {
    render(FieldPolicyEditor, {
      props: {
        state: stateFor({ manage: true, personalize: false }),
        adapter: adapter(),
        fields,
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    const organization = screen.getByRole('tab', { name: 'Organization' });
    const panel = screen.getByRole('tabpanel');
    expect(screen.queryByRole('tab', { name: 'Just me' })).toBeNull();
    expect(organization).toHaveAttribute('aria-selected', 'true');
    expect(organization).toHaveAttribute('tabindex', '0');
    expect(organization).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', organization.id);
    organization.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowRight}{Home}{End}');
    expect(organization).toHaveFocus();
  });

  it('prevents a required defaultless field from being hidden', async () => {
    render(FieldPolicyEditor, {
      props: {
        state: stateFor(),
        adapter: adapter(),
        fields,
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    const visibility = screen.getAllByLabelText('Visibility')[0];
    await userEvent.selectOptions(visibility, 'hidden');
    expect(screen.getByText(/Add a usable default/i)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeDisabled();
  });

  it('blocks an app-row default removal when no lower code default exists', async () => {
    const state = stateFor();
    state.policy.fields.title.hasDefault = true;
    state.policy.fields.title.defaultValue = 'app default';
    state.policy.layers.title = [
      {
        layer: 'app',
        delta: { default: { value: 'app default' } },
      },
    ];
    state.rows.app = [
      {
        id: 'app-title',
        fieldName: 'title',
        scopeType: 'app',
        tenantId: null,
        userId: null,
        updatedBy: null,
        defaultValue: '"app default"',
        displayOrder: null,
        help: null,
        label: null,
        locked: null,
        visibility: null,
      },
    ];
    render(FieldPolicyEditor, {
      props: {
        state,
        adapter: adapter(),
        fields,
        organizationScope: 'app',
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    await userEvent.click(
      screen.getAllByRole('checkbox', { name: 'Override default value' })[0],
    );
    await userEvent.selectOptions(
      screen.getAllByLabelText('Visibility')[0],
      'hidden',
    );
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeDisabled();
  });

  it('permits a personal required-default removal when the server reports a usable lower default', async () => {
    const state = stateFor({ manage: false, personalize: true });
    state.personalLowerDefaultUsable.title = true;
    state.policy.fields.title.hasDefault = true;
    state.policy.fields.title.defaultValue = 'personal default';
    state.policy.fields.title.visibility = 'hidden';
    // Personal-only state deliberately has no app/tenant explanation layer or
    // raw row, so the boolean signal is the only fallback information.
    state.policy.layers.title = [
      {
        layer: 'user',
        delta: { default: { value: 'personal default' }, visibility: 'hidden' },
      },
    ];
    state.rows.user = [
      {
        id: 'user-title',
        fieldName: 'title',
        scopeType: 'user',
        tenantId: null,
        userId: 'alice',
        updatedBy: null,
        defaultValue: '"personal default"',
        displayOrder: null,
        help: null,
        label: null,
        locked: null,
        visibility: 'hidden',
      },
    ];
    render(FieldPolicyEditor, {
      props: {
        state,
        adapter: adapter(),
        fields,
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    await userEvent.click(
      screen.getAllByRole('checkbox', { name: 'Override default value' })[0],
    );
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeEnabled();
  });

  it('permits clearing a current app default when the generated field has a code default', async () => {
    const state = stateFor();
    state.policy.fields.title.hasDefault = true;
    state.policy.fields.title.defaultValue = 'app default';
    state.rows.app = [
      {
        id: 'app-title',
        fieldName: 'title',
        scopeType: 'app',
        tenantId: null,
        userId: null,
        updatedBy: null,
        defaultValue: '"app default"',
        displayOrder: null,
        help: null,
        label: null,
        locked: null,
        visibility: null,
      },
    ];
    render(FieldPolicyEditor, {
      props: {
        state,
        adapter: adapter(),
        fields: {
          ...fields,
          title: { type: 'text', required: true, default: 'code default' },
        },
        organizationScope: 'app',
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    await userEvent.click(
      screen.getAllByRole('checkbox', { name: 'Override default value' })[0],
    );
    await userEvent.selectOptions(
      screen.getAllByLabelText('Visibility')[0],
      'hidden',
    );
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeEnabled();
  });

  it('clears invalid JSON default state when its override is disabled', async () => {
    const state = stateFor();
    state.rows.tenant = [
      {
        id: 'tenant-title',
        fieldName: 'title',
        scopeType: 'tenant',
        tenantId: 'tenant-a',
        userId: null,
        updatedBy: null,
        defaultValue: '"seed"',
        displayOrder: null,
        help: null,
        label: null,
        locked: null,
        visibility: null,
      },
    ];
    render(FieldPolicyEditor, {
      props: {
        state,
        adapter: adapter(),
        fields: { ...fields, title: { type: 'json', required: true } },
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    const json = screen.getByLabelText('Default value') as HTMLTextAreaElement;
    json.value = '{bad';
    json.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeDisabled();
    await userEvent.click(
      screen.getAllByRole('checkbox', { name: 'Override default value' })[0],
    );
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeEnabled();
  });

  it('remounts default JSON inputs across scope tabs without leaking invalid drafts', async () => {
    const state = stateFor();
    state.rows.tenant = [
      {
        id: 'tenant-title',
        fieldName: 'title',
        scopeType: 'tenant',
        tenantId: 'tenant-a',
        userId: null,
        updatedBy: null,
        defaultValue: '"seed"',
        displayOrder: null,
        help: null,
        label: null,
        locked: null,
        visibility: null,
      },
    ];
    render(FieldPolicyEditor, {
      props: {
        state,
        adapter: adapter(),
        fields: { ...fields, title: { type: 'json', required: true } },
        onclose: () => undefined,
        onmutated: async () => undefined,
      },
    });
    const json = screen.getByLabelText('Default value') as HTMLTextAreaElement;
    json.value = '{bad';
    json.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expect(screen.getAllByText(/Enter valid JSON/i).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: 'Just me' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Organization' }));
    expect(screen.queryByText(/Enter valid JSON/i)).toBeNull();
    expect(
      screen.getAllByRole('button', { name: 'Save', exact: true })[0],
    ).toBeEnabled();
  });
});
