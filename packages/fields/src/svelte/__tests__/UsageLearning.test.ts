// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import FieldPolicySuggestionQueue from '../components/FieldPolicySuggestionQueue.svelte';
import type { FieldPolicyEditorAdapter } from '../field-policy-editor.js';
import {
  type FieldPolicySuggestionAdapter,
  parsePendingFieldPolicySuggestions,
} from '../suggestions.js';
import {
  collectFieldUsageEntries,
  reportFieldUsage,
} from '../usage-capture.js';
import SuggestionGearFixture from './fixtures/SuggestionGearFixture.svelte';

const pending = {
  suggestions: [
    {
      id: 'suggestion-1',
      objectRef: '@test:Widget',
      fieldName: 'status',
      kind: 'promote' as const,
      proposedValue: null,
      evidence: { summary: '6 users set this field 12 times.' },
      status: 'pending',
    },
  ],
  total: 1,
};

function suggestionAdapter(): FieldPolicySuggestionAdapter {
  return {
    pendingSuggestions: vi.fn(async () => pending),
    acceptSuggestion: vi.fn(async () => undefined),
    dismissSuggestion: vi.fn(async () => undefined),
  };
}

const editorAdapter: FieldPolicyEditorAdapter = {
  load: async () => ({
    capabilities: { manage: true, personalize: false },
    personalLowerDefaultUsable: {},
    policy: { objectRef: '@test:Widget', fields: {}, layers: {} },
    rows: { app: [], tenant: [], user: [] },
  }),
  create: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
};

describe('field usage capture', () => {
  it('keeps free-form values out of browser telemetry while retaining count signals', () => {
    expect(
      collectFieldUsageEntries({
        objectRef: '@test:Widget',
        fields: {
          title: 'text',
          enabled: 'boolean',
          count: 'integer',
          ownerId: 'foreignKey',
          metadata: 'json',
        },
        values: {
          title: 'A title',
          enabled: false,
          count: 0,
          ownerId: '4f552b7e-88a4-499a-9ce4-6a88bec3b439',
          metadata: { email: 'member@example.test' },
          omitted: 'not rendered',
        },
        defaults: {
          title: { hasDefault: true, defaultValue: 'A title' },
          count: { hasDefault: true, defaultValue: 1 },
          metadata: {
            hasDefault: true,
            defaultValue: { email: 'member@example.test' },
          },
        },
      }),
    ).toEqual([
      {
        objectRef: '@test:Widget',
        fieldName: 'title',
        matchedDefault: true,
      },
      { objectRef: '@test:Widget', fieldName: 'enabled', value: false },
      { objectRef: '@test:Widget', fieldName: 'count' },
      {
        objectRef: '@test:Widget',
        fieldName: 'ownerId',
        value: '4f552b7e-88a4-499a-9ce4-6a88bec3b439',
      },
      {
        objectRef: '@test:Widget',
        fieldName: 'metadata',
        matchedDefault: true,
      },
    ]);
  });

  it('contains synchronous and asynchronous reporter failures outside the submit path', async () => {
    const sync = {
      reportUsage: () => {
        throw new Error('offline');
      },
    };
    const rejected = {
      reportUsage: async () => {
        throw new Error('offline');
      },
    };
    expect(() =>
      reportFieldUsage(sync, [
        { objectRef: '@test:Widget', fieldName: 'title' },
      ]),
    ).not.toThrow();
    expect(() =>
      reportFieldUsage(rejected, [
        { objectRef: '@test:Widget', fieldName: 'title' },
      ]),
    ).not.toThrow();
    await Promise.resolve();
  });
});

describe('field policy suggestion review', () => {
  it('fails closed for malformed generated-action output', () => {
    expect(() =>
      parsePendingFieldPolicySuggestions({ suggestions: [], total: '1' }),
    ).toThrow(/Unable to load pending/i);
    expect(() =>
      parsePendingFieldPolicySuggestions({
        suggestions: [{ id: 'missing fields' }],
        total: 1,
      }),
    ).toThrow(/Unable to load pending/i);
  });

  it('renders an accessible reviewed queue and refreshes after approve or dismiss', async () => {
    const adapter = suggestionAdapter();
    const { container } = render(FieldPolicySuggestionQueue, {
      props: { adapter, objectRefs: ['@test:Widget'] },
    });
    await vi.waitFor(() =>
      expect(screen.getByText(/6 users set/i)).toBeVisible(),
    );
    expect(
      screen.getByRole('heading', { name: 'Pending field suggestions' }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() =>
      expect(adapter.acceptSuggestion).toHaveBeenCalledWith({
        id: 'suggestion-1',
      }),
    );
    expect(adapter.pendingSuggestions).toHaveBeenCalledWith({
      objectRefs: ['@test:Widget'],
    });
    await expectNoA11yViolations(container);
  });

  it('announces a pending-suggestion count on the policy gear without exposing suggestion details', async () => {
    render(SuggestionGearFixture, {
      props: { adapter: editorAdapter, suggestionAdapter: suggestionAdapter() },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Field settings, 1 pending suggestion',
        }),
      ).toBeVisible(),
    );
    expect(screen.getByText('1')).toHaveAttribute('aria-hidden', 'true');
  });
});
