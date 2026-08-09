// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type {
  FieldPolicyDetailItem,
  FieldPolicySettingsCatalogData,
} from '../../settings-catalog.js';
import type {
  FieldPolicyAuditSnapshot,
  FieldPolicyEditorState,
} from '../../types.js';
import FieldPolicyControlPanel from '../components/FieldPolicyControlPanel.svelte';
import type { FieldPolicyControlPanelAdapter } from '../settings-catalog.js';
import type { FieldPolicySuggestionAdapter } from '../suggestions.js';
import SettingsCatalogStub from './fixtures/SettingsCatalogStub.svelte';

const objectRef = '@test/smrt-fields:ControlPanelDocument';

function editorState(): FieldPolicyEditorState {
  return {
    capabilities: { manage: true, personalize: false },
    personalLowerDefaultUsable: { title: false },
    policy: {
      objectRef,
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
          required: false,
        },
      },
      layers: { title: [] },
    },
    rows: {
      app: [],
      tenant: [
        {
          id: 'org-title',
          fieldName: 'title',
          scopeType: 'tenant',
          tenantId: 'tenant',
          userId: null,
          defaultValue: null,
          displayOrder: null,
          help: null,
          label: null,
          locked: null,
          visibility: null,
        },
      ],
      user: [],
    },
  };
}

function audit(orgIds = ['org-title'], drift = true): FieldPolicyAuditSnapshot {
  return {
    caller: {
      tenantId: 'tenant',
      userId: 'user',
      canManageOrg: true,
      canPersonalize: false,
    },
    appRows: [],
    orgRows: orgIds.map((id) => ({
      id,
      objectRef,
      fieldName: 'title',
      scopeType: 'tenant' as const,
      tenantId: 'tenant',
      userId: null,
      updatedBy: null,
      createdAt: null,
      updatedAt: null,
      defaultValue: null,
      displayOrder: null,
      help: null,
      label: null,
      locked: null,
      visibility: null,
    })),
    inheritedOrgKeys: {},
    userOverrideCounts: {},
    driftRows: drift
      ? [
          {
            id: 'stale-row',
            objectRef,
            fieldName: 'retired',
            scopeType: 'tenant' as const,
            tenantId: 'tenant',
            userId: null,
            updatedBy: null,
            createdAt: null,
            updatedAt: null,
            reason: 'unknown-field' as const,
            prunable: true,
          },
        ]
      : [],
    policies: {
      [objectRef]: editorState().policy,
    },
  };
}

function data(pageSize = 25): FieldPolicySettingsCatalogData {
  const selected: FieldPolicyDetailItem = {
    id: `${objectRef}::title`,
    label: 'title',
    objectRef,
    fieldName: 'title',
    className: 'ControlPanelDocument',
    packageName: '@test/smrt-fields',
    fields: { title: { type: 'text' } },
  };
  return {
    page: {
      items: [selected],
      selected,
      query: '',
      page: 1,
      pageSize,
      total: 1,
    },
    audit: audit(),
    objects: [],
    packages: [],
    filters: {
      packageFilter: null,
      objectFilter: null,
      customizedOnly: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function adapter(
  options: { onDelete?: (id: string) => Promise<void>; calls?: string[] } = {},
): FieldPolicyControlPanelAdapter {
  return {
    load: vi.fn(async () => {
      options.calls?.push('load');
      return editorState();
    }),
    loadAudit: vi.fn(async (input) => {
      options.calls?.push('audit');
      return audit();
    }),
    create: vi.fn(async () => undefined),
    update: vi.fn(async () => {
      options.calls?.push('update');
    }),
    delete: vi.fn(async ({ id }) => {
      options.calls?.push(`delete:${id}`);
      await options.onDelete?.(id);
    }),
  };
}

function renderPanel(
  panelAdapter = adapter(),
  options: {
    confirmAction?: (message: string) => boolean | Promise<boolean>;
    onchanged?: () => void;
    panelData?: FieldPolicySettingsCatalogData;
    suggestionAdapter?: FieldPolicySuggestionAdapter;
  } = {},
) {
  return render(FieldPolicyControlPanel, {
    props: {
      data: options.panelData ?? data(),
      adapter: panelAdapter,
      catalog: SettingsCatalogStub,
      baseUrl: '/settings/fields',
      confirmAction: options.confirmAction,
      onchanged: options.onchanged,
      suggestionAdapter: options.suggestionAdapter,
    },
  });
}

describe('FieldPolicyControlPanel', () => {
  it('surfaces a reviewed pending-suggestion queue through the structural host adapter', async () => {
    const pendingSuggestions = vi.fn(async () => ({
      suggestions: [
        {
          id: 'suggestion-title',
          objectRef,
          fieldName: 'title',
          kind: 'promote',
          proposedValue: null,
          evidence: { summary: '3 users set this field 5 times.' },
          status: 'pending',
        },
      ],
      total: 1,
    }));
    renderPanel(adapter(), {
      suggestionAdapter: {
        pendingSuggestions,
        acceptSuggestion: async () => undefined,
        dismissSuggestion: async () => undefined,
      },
    });

    await vi.waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Pending field suggestions' }),
      ).toBeVisible(),
    );
    expect(pendingSuggestions).toHaveBeenCalledWith({
      objectRefs: [objectRef],
    });
  });

  it('uses SSR data for the first render and preserves pageSize in catalog navigation', () => {
    renderPanel();

    expect(
      screen.getByRole('heading', { name: 'Field settings' }),
    ).toBeVisible();
    expect(screen.getByText('Title')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'catalog navigation' }),
    ).toHaveAttribute('href', '/settings/fields?pageSize=25');
  });

  it('refreshes audit with drift and reloads editor state before notifying after an editor mutation', async () => {
    const calls: string[] = [];
    const panelAdapter = adapter({ calls });
    const onchanged = () => calls.push('changed');
    renderPanel(panelAdapter, { onchanged });
    await vi.waitFor(() => expect(panelAdapter.load).toHaveBeenCalledTimes(1));
    calls.length = 0;

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit settings' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Save', exact: true }),
    );

    await vi.waitFor(() =>
      expect(calls).toEqual(['update', 'audit', 'load', 'changed']),
    );
    expect(panelAdapter.loadAudit).toHaveBeenLastCalledWith({
      objectRefs: [objectRef],
      countObjectRefs: [objectRef],
      includeDrift: true,
    });
  });

  it('does not reset organization rows or prune drift when confirmation is declined', async () => {
    const panelAdapter = adapter();
    const confirmAction = vi.fn(() => false);
    renderPanel(panelAdapter, { confirmAction });
    await vi.waitFor(() => expect(panelAdapter.load).toHaveBeenCalledTimes(1));
    vi.mocked(panelAdapter.delete).mockClear();

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset all organization overrides for this object',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Prune' }));

    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(panelAdapter.delete).not.toHaveBeenCalled();
  });

  it('refreshes audit and editor state after a partial organization reset failure', async () => {
    const calls: string[] = [];
    const panelAdapter = adapter({
      calls,
      onDelete: async (id) => {
        if (id === 'org-second') throw new Error('second delete failed');
      },
    });
    renderPanel(panelAdapter, {
      confirmAction: () => true,
      panelData: { ...data(), audit: audit(['org-first', 'org-second']) },
    });
    await vi.waitFor(() => expect(panelAdapter.load).toHaveBeenCalledTimes(1));
    calls.length = 0;

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reset all organization overrides for this object',
      }),
    );

    await vi.waitFor(() =>
      expect(calls).toEqual([
        'delete:org-first',
        'delete:org-second',
        'audit',
        'load',
      ]),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('second delete failed');
  });

  it('does not let an older deferred audit refresh overwrite newer panel data', async () => {
    const staleAudit = deferred<FieldPolicyAuditSnapshot>();
    const panelAdapter = adapter();
    panelAdapter.loadAudit = vi.fn(() => staleAudit.promise);
    const rendered = renderPanel(panelAdapter);
    await vi.waitFor(() => expect(panelAdapter.load).toHaveBeenCalledTimes(1));

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit settings' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Save', exact: true }),
    );
    await vi.waitFor(() =>
      expect(panelAdapter.loadAudit).toHaveBeenCalledTimes(1),
    );

    await rendered.rerender({
      data: { ...data(), audit: audit([], false) },
    });
    expect(
      screen.queryByRole('heading', { name: 'Manifest drift' }),
    ).toBeNull();

    staleAudit.resolve(audit());
    await Promise.resolve();
    expect(
      screen.queryByRole('heading', { name: 'Manifest drift' }),
    ).toBeNull();
  });
});
