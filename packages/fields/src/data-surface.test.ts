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
    projectableColumnIds: ['id', 'title', 'secret'],
    searchableColumnIds: ['title', 'secret'],
    filterableColumnIds: ['title', 'secret'],
    sortableColumnIds: ['title', 'secret'],
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
      order: 1,
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
  },
};

describe('field policy DataSurface adapter (#2449)', () => {
  it('publishes policy labels, descriptions, ordering, visibility, and operator metadata', () => {
    const result = policyToDataSurfaceDescriptor(policy, descriptor);
    expect(result.columns.map((column) => column.id)).toEqual([
      'id',
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
      order: 1,
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
      'title',
      'computed',
      'selection',
      'actions',
    ]);
    expect(result.actions.map((action) => action.id)).toEqual(['export']);
    expect(result.query.projectableColumnIds).not.toContain('secret');
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
});
