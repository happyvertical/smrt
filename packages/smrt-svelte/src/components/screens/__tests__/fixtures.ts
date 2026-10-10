import type {
  ScreenCollectionDefinition,
  ScreenPolicy,
  ScreenRecord,
} from '../types.js';

/** A representative model: every wire type and widget the screens handle. */
export const taskDefinition: ScreenCollectionDefinition = {
  objectRef: '@acme/tasks:Task',
  className: 'Task',
  idField: 'id',
  fields: {
    id: { type: 'text' },
    tenantId: { type: 'text' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
    title: { type: 'text', required: true, ui: { basic: true, order: 1 } },
    notes: {
      type: 'text',
      description: 'Free-form notes.',
      ui: { basic: true, widget: 'textarea' },
    },
    budget: { type: 'integer', ui: { basic: true, widget: 'currency' } },
    priority: { type: 'integer', default: 3, ui: { basic: true } },
    done: { type: 'boolean', default: false, ui: { basic: true } },
    dueAt: { type: 'datetime', nullable: true, ui: { basic: true } },
    ownerId: { type: 'foreignKey', ui: { basic: true } },
    payload: { type: 'json', ui: { basic: false } },
    reference: { type: 'text', ui: { basic: false, group: 'Tracking' } },
    secretToken: { type: 'text' },
    _internal: { type: 'text' },
  },
};

/**
 * Resolved policy as smrt-fields would emit it: no `secretToken` (omitted as
 * sensitive), `payload` demoted to advanced, `reference` hidden.
 */
export const taskPolicy: ScreenPolicy = {
  objectRef: '@acme/tasks:Task',
  fields: {
    title: {
      visibility: 'basic',
      label: 'Task name',
      help: 'What needs doing',
      order: 1,
      required: true,
    },
    notes: { visibility: 'advanced', order: 20 },
    budget: { visibility: 'basic', order: 3, required: false },
    priority: {
      visibility: 'basic',
      order: 2,
      hasDefault: true,
      defaultValue: 5,
    },
    done: { visibility: 'basic', order: 4 },
    dueAt: { visibility: 'basic', order: 5 },
    ownerId: { visibility: 'basic', order: 6 },
    payload: { visibility: 'advanced', order: 30 },
    reference: { visibility: 'hidden' },
  },
};

export const taskRows: ScreenRecord[] = [
  {
    id: 't-1',
    title: 'Write docs',
    budget: 125050,
    priority: 2,
    done: false,
    dueAt: '2026-10-09T12:30:00.000Z',
    ownerId: '0b0c7b5e-0000-4000-8000-000000000001',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
  },
  {
    id: 't-2',
    title: 'Ship release',
    budget: 0,
    priority: 1,
    done: true,
    dueAt: null,
    ownerId: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
  },
];
