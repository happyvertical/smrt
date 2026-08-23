import type { DataSurfaceDescriptor } from '@happyvertical/smrt-ui/data';
import { describe, expect, it } from 'vitest';
import {
  applyFieldPolicyToDataSurface,
  policyToDataSurfaceDescriptor,
} from './data-surface.js';
import type { ResolvedObjectFieldPolicy } from './types.js';

const descriptor: DataSurfaceDescriptor = {
  version: 1,
  identity: { surfaceId: 'library', kind: 'table' },
  schemaVersion: 1,
  label: 'Library',
  rowKey: 'id',
  columns: [
    {
      id: 'id',
      label: 'ID',
      role: 'row-key',
      capabilities: ['read', 'project'],
    },
    {
      id: 'title',
      label: 'Title',
      fieldName: 'title',
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
      operators: {
        search: ['contains'],
        filter: ['equals', 'contains'],
        sort: ['asc', 'desc'],
      },
    },
    {
      id: 'secret',
      label: 'Secret',
      fieldName: 'secret',
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    },
    {
      id: 'restricted',
      label: 'Restricted',
      fieldName: 'restricted',
      sensitivity: 'sensitive',
      readable: true,
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    },
    {
      id: 'unreadable',
      label: 'Unreadable',
      fieldName: 'unreadable',
      readable: false,
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    },
    {
      id: 'native-hidden',
      label: 'Native hidden',
      fieldName: 'nativeHidden',
      visibility: 'hidden',
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    },
    {
      id: 'secondary',
      label: 'Secondary',
      fieldName: 'secondary',
      capabilities: ['read', 'project'],
    },
    {
      id: 'computed',
      label: 'Computed',
      role: 'computed',
      capabilities: ['read'],
    },
    {
      id: 'selection',
      label: 'Select',
      role: 'selection',
      capabilities: [],
    },
    {
      id: 'actions',
      label: 'Actions',
      role: 'action',
      capabilities: [],
    },
  ],
  query: {
    modes: ['rows', 'count', 'facets'],
    projectableColumnIds: [
      'id',
      'title',
      'secret',
      'restricted',
      'unreadable',
      'native-hidden',
    ],
    searchableColumnIds: [
      'title',
      'secret',
      'restricted',
      'unreadable',
      'native-hidden',
    ],
    filterableColumnIds: [
      'title',
      'secret',
      'restricted',
      'unreadable',
      'native-hidden',
    ],
    sortableColumnIds: [
      'title',
      'secret',
      'restricted',
      'unreadable',
      'native-hidden',
    ],
  },
  controls: [],
  actions: [
    {
      id: 'export',
      label: 'Export',
      selectionScopes: ['current-page'],
      columnIds: ['title'],
    },
    {
      id: 'reveal-secret',
      label: 'Reveal secret',
      selectionScopes: ['explicit-ids'],
      columnIds: ['secret'],
    },
  ],
  limits: { maxQueryRows: 100, maxQueryBytes: 10_000, maxSelectionSize: 20 },
};

const policy: ResolvedObjectFieldPolicy = {
  objectRef: '@test:Library',
  fields: {
    title: {
      fieldName: 'title',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'basic',
      help: 'The public title',
      label: 'Display title',
      order: 2,
      group: null,
      locked: false,
      required: false,
    },
    secret: {
      fieldName: 'secret',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'hidden',
      help: 'Do not expose this value',
      label: 'Secret value',
      order: 99,
      group: null,
      locked: false,
      required: false,
    },
    secondary: {
      fieldName: 'secondary',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'advanced',
      help: null,
      label: 'Secondary field',
      order: 1,
      group: null,
      locked: false,
      required: false,
    },
  },
};

describe('field policy DataSurface adapter (#2449)', () => {
  it('publishes policy labels, descriptions, ordering, visibility, and operator metadata', () => {
    const result = policyToDataSurfaceDescriptor(policy, descriptor);
    expect(result.columns.map((column) => column.id)).toEqual([
      'id',
      'secondary',
      'title',
      'computed',
      'selection',
      'actions',
    ]);
    expect(
      result.columns.find((column) => column.id === 'title'),
    ).toMatchObject({
      label: 'Display title',
      description: 'The public title',
      visibility: 'basic',
      order: 2,
      operators: {
        search: ['contains'],
        filter: ['equals', 'contains'],
        sort: ['asc', 'desc'],
      },
    });
    expect(result.query).toMatchObject({
      projectableColumnIds: ['id', 'title'],
      searchableColumnIds: ['title'],
      filterableColumnIds: ['title'],
      sortableColumnIds: ['title'],
    });
  });

  it('keeps computed, selection, and action columns while removing hidden fields and actions', () => {
    const result = applyFieldPolicyToDataSurface(policy, descriptor);
    expect(result.columns.map((column) => column.id)).toEqual([
      'id',
      'secondary',
      'title',
      'computed',
      'selection',
      'actions',
    ]);
    expect(result.actions.map((action) => action.id)).toEqual(['export']);
    expect(result.query.projectableColumnIds).not.toContain('secret');
    expect(result.columns.map((column) => column.id)).not.toContain(
      'restricted',
    );
    expect(result.columns.map((column) => column.id)).not.toContain(
      'unreadable',
    );
    expect(result.columns.map((column) => column.id)).not.toContain(
      'native-hidden',
    );
  });

  it('keeps restricted fields fail-closed unless the host explicitly authorizes them', () => {
    const restrictedDescriptor = {
      ...descriptor,
      columns: descriptor.columns.map((column) =>
        column.id === 'restricted'
          ? { ...column, visibility: undefined }
          : column,
      ),
    };
    const denied = policyToDataSurfaceDescriptor(policy, restrictedDescriptor);
    expect(denied.columns.map((column) => column.id)).not.toContain(
      'restricted',
    );
    expect(denied.query.projectableColumnIds).not.toContain('restricted');

    const authorized = policyToDataSurfaceDescriptor(
      policy,
      restrictedDescriptor,
      {
        authorizedColumnIds: ['restricted'],
      },
    );
    expect(authorized.columns.map((column) => column.id)).toContain(
      'restricted',
    );
    expect(
      authorized.columns.find((column) => column.id === 'restricted'),
    ).toMatchObject({
      readable: true,
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    });
  });

  it('makes explicitly authorized unreadable metadata internally consistent', () => {
    const denied = policyToDataSurfaceDescriptor(policy, descriptor);
    expect(
      denied.columns.find((column) => column.id === 'unreadable'),
    ).toBeUndefined();
    expect(denied.query.projectableColumnIds).not.toContain('unreadable');

    const authorized = policyToDataSurfaceDescriptor(policy, descriptor, {
      authorizedColumnIds: ['unreadable'],
    });
    expect(
      authorized.columns.find((column) => column.id === 'unreadable'),
    ).toMatchObject({
      readable: true,
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    });
    expect(authorized.query.projectableColumnIds).toContain('unreadable');
  });

  it('normalizes authorized sensitive structural readability and projectability', () => {
    const structuralIds = ['id', 'computed', 'selection', 'actions'];
    const structuralDescriptor: DataSurfaceDescriptor = {
      ...descriptor,
      columns: descriptor.columns.map((column) =>
        structuralIds.includes(column.id)
          ? {
              ...column,
              sensitivity: 'sensitive' as const,
              capabilities:
                column.id === 'id' || column.id === 'computed'
                  ? ['read', 'project']
                  : [],
            }
          : column,
      ),
      query: {
        ...descriptor.query,
        projectableColumnIds: [
          ...descriptor.query.projectableColumnIds,
          'computed',
        ],
      },
    };

    const denied = policyToDataSurfaceDescriptor(policy, structuralDescriptor);
    expect(denied.columns.map((column) => column.id)).not.toEqual(
      expect.arrayContaining(['computed', 'selection', 'actions']),
    );
    expect(denied.columns.find((column) => column.id === 'id')).toMatchObject({
      readable: false,
      capabilities: [],
    });
    expect(denied.query.projectableColumnIds).not.toContain('id');
    expect(denied.query.projectableColumnIds).not.toContain('computed');

    const authorized = policyToDataSurfaceDescriptor(
      policy,
      structuralDescriptor,
      { authorizedColumnIds: structuralIds },
    );
    for (const id of structuralIds) {
      expect(
        authorized.columns.find((column) => column.id === id),
      ).toMatchObject({ readable: true });
    }
    expect(authorized.query.projectableColumnIds).toContain('id');
    expect(authorized.query.projectableColumnIds).toContain('computed');
  });

  it('cannot broaden static hidden/readability constraints', () => {
    const result = policyToDataSurfaceDescriptor(policy, descriptor, {
      staticHiddenColumnIds: ['title'],
    });
    expect(result.columns.map((column) => column.id)).not.toContain('title');
    expect(result.query.searchableColumnIds).toEqual([]);
    expect(result.query.filterableColumnIds).toEqual([]);
    expect(result.query.sortableColumnIds).toEqual([]);
  });

  it('retains a hidden row key only as a capability-free identity column', () => {
    const hiddenRowKey = {
      ...descriptor,
      columns: descriptor.columns.map((column) =>
        column.id === 'id'
          ? { ...column, visibility: 'hidden' as const }
          : column,
      ),
    };

    const result = policyToDataSurfaceDescriptor(policy, hiddenRowKey);
    expect(result.columns[0]).toMatchObject({
      id: 'id',
      visibility: 'hidden',
      readable: false,
      capabilities: [],
      operators: {},
    });
    expect(result.query.projectableColumnIds).not.toContain('id');
  });

  it('removes static-hidden structural columns from discovery and commands', () => {
    const hiddenIds = ['computed', 'selection', 'actions'];
    const searchableColumnIds = descriptor.query.searchableColumnIds ?? [];
    const filterableColumnIds = descriptor.query.filterableColumnIds ?? [];
    const sortableColumnIds = descriptor.query.sortableColumnIds ?? [];
    const structuralDescriptor: DataSurfaceDescriptor = {
      ...descriptor,
      query: {
        ...descriptor.query,
        projectableColumnIds: [
          ...descriptor.query.projectableColumnIds,
          ...hiddenIds,
        ],
        searchableColumnIds: [...searchableColumnIds, ...hiddenIds],
        filterableColumnIds: [...filterableColumnIds, ...hiddenIds],
        sortableColumnIds: [...sortableColumnIds, ...hiddenIds],
      },
      actions: [
        ...descriptor.actions,
        {
          id: 'run-computed',
          label: 'Run computed',
          selectionScopes: ['current-page'],
          columnIds: ['computed'],
        },
      ],
    };

    const result = policyToDataSurfaceDescriptor(policy, structuralDescriptor, {
      staticHiddenColumnIds: hiddenIds,
    });

    for (const id of hiddenIds) {
      expect(result.columns.map((column) => column.id)).not.toContain(id);
      expect(result.query.projectableColumnIds).not.toContain(id);
      expect(result.query.searchableColumnIds).not.toContain(id);
      expect(result.query.filterableColumnIds).not.toContain(id);
      expect(result.query.sortableColumnIds).not.toContain(id);
    }
    expect(result.actions.map((action) => action.id)).not.toContain(
      'run-computed',
    );
  });

  it('removes policy-hidden structural columns and dependent actions', () => {
    const hiddenIds = ['computed', 'selection', 'actions'];
    const searchableColumnIds = descriptor.query.searchableColumnIds ?? [];
    const filterableColumnIds = descriptor.query.filterableColumnIds ?? [];
    const sortableColumnIds = descriptor.query.sortableColumnIds ?? [];
    const structuralDescriptor: DataSurfaceDescriptor = {
      ...descriptor,
      columns: descriptor.columns.map((column) =>
        hiddenIds.includes(column.id)
          ? { ...column, fieldName: column.id }
          : column,
      ),
      query: {
        ...descriptor.query,
        projectableColumnIds: [
          ...descriptor.query.projectableColumnIds,
          ...hiddenIds,
        ],
        searchableColumnIds: [...searchableColumnIds, ...hiddenIds],
        filterableColumnIds: [...filterableColumnIds, ...hiddenIds],
        sortableColumnIds: [...sortableColumnIds, ...hiddenIds],
      },
      actions: [
        ...descriptor.actions,
        {
          id: 'run-selection',
          label: 'Run selection',
          selectionScopes: ['current-page'],
          columnIds: ['selection'],
        },
      ],
    };
    const structuralPolicy: ResolvedObjectFieldPolicy = {
      ...policy,
      fields: {
        ...policy.fields,
        ...Object.fromEntries(
          hiddenIds.map((fieldName) => [
            fieldName,
            {
              ...policy.fields.title,
              fieldName,
              visibility: 'hidden' as const,
              label: `${fieldName} label`,
              help: `${fieldName} help`,
            },
          ]),
        ),
      },
    };

    const result = policyToDataSurfaceDescriptor(
      structuralPolicy,
      structuralDescriptor,
    );

    for (const id of hiddenIds) {
      expect(result.columns.map((column) => column.id)).not.toContain(id);
      expect(result.query.projectableColumnIds).not.toContain(id);
      expect(result.query.searchableColumnIds).not.toContain(id);
      expect(result.query.filterableColumnIds).not.toContain(id);
      expect(result.query.sortableColumnIds).not.toContain(id);
    }
    expect(result.actions.map((action) => action.id)).not.toContain(
      'run-selection',
    );
  });
});
