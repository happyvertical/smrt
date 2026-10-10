import { describe, expect, it } from 'vitest';
import {
  deriveScreenFields,
  groupScreenFields,
  humanizeFieldName,
  inputKindFor,
  screenSourceError,
  screenTitles,
} from '../fields.js';
import type { ScreenCollectionDefinition } from '../types.js';
import { taskDefinition, taskPolicy } from './fixtures.js';

const names = (fields: { name: string }[]) => fields.map((f) => f.name);

describe('humanizeFieldName', () => {
  it('splits camel case, snake case and acronyms', () => {
    expect(humanizeFieldName('dueDate')).toBe('Due date');
    expect(humanizeFieldName('billing_address')).toBe('Billing address');
    expect(humanizeFieldName('apiURLKey')).toBe('Api url key');
    expect(humanizeFieldName('title')).toBe('Title');
  });
});

describe('screenTitles', () => {
  it('derives a readable singular and plural from the class name', () => {
    expect(screenTitles({ ...taskDefinition, className: 'Task' })).toEqual({
      singular: 'Task',
      plural: 'Tasks',
    });
    expect(
      screenTitles({ ...taskDefinition, className: 'FactSource' }).plural,
    ).toBe('Fact sources');
    expect(
      screenTitles({ ...taskDefinition, className: 'Category' }).plural,
    ).toBe('Categories');
    expect(
      screenTitles({ ...taskDefinition, className: 'Address' }).plural,
    ).toBe('Addresses');
  });
});

describe('inputKindFor', () => {
  it('maps wire types and widget hints', () => {
    expect(inputKindFor({ type: 'text' })).toBe('text');
    expect(inputKindFor({ type: 'text', ui: { widget: 'textarea' } })).toBe(
      'textarea',
    );
    expect(inputKindFor({ type: 'text', ui: { widget: 'phone' } })).toBe('tel');
    expect(inputKindFor({ type: 'integer', ui: { widget: 'currency' } })).toBe(
      'money',
    );
    expect(inputKindFor({ type: 'integer' })).toBe('integer');
    // Money is integer minor units only: a decimal never becomes money.
    expect(inputKindFor({ type: 'decimal', ui: { widget: 'currency' } })).toBe(
      'decimal',
    );
    expect(inputKindFor({ type: 'crossPackageRef' })).toBe('reference');
    expect(inputKindFor({ type: 'json' })).toBe('json');
  });
});

describe('deriveScreenFields with a resolved policy', () => {
  it('edit: policy order, labels and help; hidden, unknown and system fields never appear', () => {
    const fields = deriveScreenFields(taskDefinition, taskPolicy, {
      mode: 'edit',
    });
    expect(names(fields)).toEqual([
      'title',
      'priority',
      'budget',
      'done',
      'dueAt',
      'ownerId',
      'notes',
      'payload',
    ]);
    const title = fields[0];
    expect(title.label).toBe('Task name');
    expect(title.help).toBe('What needs doing');
    expect(title.required).toBe(true);
    // `secretToken` is absent from the policy, so it is never rendered.
    expect(names(fields)).not.toContain('secretToken');
    expect(names(fields)).not.toContain('reference');
    expect(names(fields)).not.toContain('_internal');
    expect(names(fields)).not.toContain('id');
    expect(names(fields)).not.toContain('createdAt');
  });

  it('splits basic and advanced tiers from the policy', () => {
    const fields = deriveScreenFields(taskDefinition, taskPolicy, {
      mode: 'edit',
    });
    expect(
      fields.filter((f) => f.tier === 'advanced').map((f) => f.name),
    ).toEqual(['notes', 'payload']);
  });

  it('falls back to the manifest description for help when the policy has none', () => {
    const fields = deriveScreenFields(taskDefinition, taskPolicy, {
      mode: 'edit',
    });
    expect(fields.find((f) => f.name === 'notes')?.help).toBe(
      'Free-form notes.',
    );
  });

  it('list: basic scalar fields only, without long text, JSON or raw references', () => {
    const fields = deriveScreenFields(taskDefinition, taskPolicy, {
      mode: 'list',
    });
    expect(names(fields)).toEqual([
      'title',
      'priority',
      'budget',
      'done',
      'dueAt',
    ]);
  });

  it('list: caps default columns, but never an explicit include', () => {
    expect(
      names(
        deriveScreenFields(taskDefinition, taskPolicy, {
          mode: 'list',
          maxListColumns: 2,
        }),
      ),
    ).toEqual(['title', 'priority']);
    expect(
      names(
        deriveScreenFields(taskDefinition, taskPolicy, {
          mode: 'list',
          include: ['dueAt', 'title', 'reference', 'secretToken', 'ownerId'],
        }),
      ),
    ).toEqual(['dueAt', 'title', 'ownerId']);
  });

  it('view: appends created/updated timestamps as advanced meta', () => {
    const fields = deriveScreenFields(taskDefinition, taskPolicy, {
      mode: 'view',
    });
    expect(names(fields).slice(-2)).toEqual(['createdAt', 'updatedAt']);
    expect(fields.slice(-2).every((f) => f.tier === 'advanced')).toBe(true);
    expect(
      names(deriveScreenFields(taskDefinition, taskPolicy, { mode: 'edit' })),
    ).not.toContain('createdAt');
  });

  it('honors exclude', () => {
    expect(
      names(
        deriveScreenFields(taskDefinition, taskPolicy, {
          mode: 'edit',
          exclude: ['notes'],
        }),
      ),
    ).not.toContain('notes');
  });

  it('policy required overrides the manifest flag', () => {
    const fields = deriveScreenFields(
      taskDefinition,
      {
        ...taskPolicy,
        fields: {
          ...taskPolicy.fields,
          budget: { visibility: 'basic', required: true },
        },
      },
      { mode: 'edit' },
    );
    expect(fields.find((f) => f.name === 'budget')?.required).toBe(true);
  });
});

describe('deriveScreenFields without a policy (code seed)', () => {
  it('applies the cold-start rule: no basic markers => everything basic', () => {
    const definition: ScreenCollectionDefinition = {
      objectRef: '@acme/x:Thing',
      className: 'Thing',
      fields: { name: { type: 'text' }, colour: { type: 'text' } },
    };
    const fields = deriveScreenFields(definition, undefined, { mode: 'edit' });
    expect(fields.map((f) => f.tier)).toEqual(['basic', 'basic']);
  });

  it('any basic marker makes unmarked fields advanced; ui.basic false is always advanced', () => {
    const fields = deriveScreenFields(taskDefinition, null, { mode: 'edit' });
    const tier = (name: string) => fields.find((f) => f.name === name)?.tier;
    expect(tier('title')).toBe('basic');
    expect(tier('payload')).toBe('advanced');
    expect(tier('secretToken')).toBe('advanced');
  });

  it('orders by ui.order then declaration order and groups by ui.group', () => {
    const fields = deriveScreenFields(taskDefinition, null, { mode: 'edit' });
    expect(fields[0].name).toBe('title');
    const grouped = groupScreenFields(fields);
    expect(grouped.map(([group]) => group)).toContain('Tracking');
    expect(grouped[0][0]).toBeNull();
  });

  it('labels a reference field without its Id suffix', () => {
    const fields = deriveScreenFields(taskDefinition, null, { mode: 'edit' });
    expect(fields.find((f) => f.name === 'ownerId')?.label).toBe('Owner');
  });
});

describe('screenSourceError', () => {
  it('flags a policy for a different object', () => {
    expect(screenSourceError(taskDefinition, taskPolicy)).toBeNull();
    expect(screenSourceError(taskDefinition, undefined)).toBeNull();
    expect(
      screenSourceError(taskDefinition, {
        ...taskPolicy,
        objectRef: '@acme/tasks:Other',
      }),
    ).toMatch(/not '@acme\/tasks:Task'/);
  });
});
