// @vitest-environment jsdom

import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  expectNoA11yViolations,
  fireEvent,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedObjectFieldPolicy } from '../../types.js';
import FieldInput from '../components/FieldInput.svelte';
import { policyToVisibleColumnIds } from '../data-table.js';
import {
  type ObjectFormCollectionDefinition,
  type ObjectFormFieldDefinition,
  ObjectFormSourceRegistry,
} from '../index.js';
import { FieldInputRegistry } from '../input-registry.js';
import { resolveObjectFormFields } from '../object-form.js';
import ObjectFormFixture from './fixtures/ObjectFormFixture.svelte';
import ObjectFormRegistryFixture from './fixtures/ObjectFormRegistryFixture.svelte';
import ObjectFormSnippetFixture from './fixtures/ObjectFormSnippetFixture.svelte';
import ObjectFormSourceFixture from './fixtures/ObjectFormSourceFixture.svelte';
import ObjectFormSourceSnippetFixture from './fixtures/ObjectFormSourceSnippetFixture.svelte';
import PolicyDataTableFixture from './fixtures/PolicyDataTableFixture.svelte';

@smrt({
  packageName: '@test/smrt-fields-object-form',
  visibility: 'internal',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: false,
  mcp: false,
})
class AcceptanceProduct extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field({ type: 'decimal' })
  price: number = 0;

  @field({ type: 'boolean', default: false })
  published: boolean = false;
}

@smrt({
  packageName: '@test/smrt-fields-object-form',
  visibility: 'internal',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: false,
  mcp: false,
})
class AcceptanceEvent extends SmrtObject {
  @field({ required: true })
  title: string = '';

  @field({ type: 'datetime' })
  startsAt: string = '';

  @field({ type: 'json' })
  metadata: Record<string, unknown> = {};
}

function objectRef(ctor: typeof SmrtObject): string {
  const registered = ObjectRegistry.getClassByConstructor(ctor);
  if (!registered?.qualifiedName)
    throw new Error('acceptance fixture did not register');
  return registered.qualifiedName;
}

function sourcePolicy(
  objectRef: string,
  definitions: Record<string, ObjectFormFieldDefinition>,
  defaults: Record<string, unknown> = {},
): ResolvedObjectFieldPolicy {
  return {
    objectRef,
    fields: Object.fromEntries(
      Object.entries(definitions).map(([fieldName, definition], index) => [
        fieldName,
        {
          fieldName,
          hasDefault: fieldName in defaults,
          defaultValue: defaults[fieldName],
          visibility: 'basic' as const,
          help: definition.description ?? null,
          label: fieldName
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (letter) => letter.toUpperCase()),
          order: index,
          group: null,
          locked: false,
          required: definition.required === true,
        },
      ]),
    ),
  };
}

const fields: Record<string, ObjectFormFieldDefinition> = {
  name: { type: 'text', required: true },
  price: { type: 'decimal', ui: { group: 'Pricing', order: 2 } },
  published: { type: 'boolean' },
  metadata: { type: 'json' },
  id: { type: 'text' },
};

const policy: ResolvedObjectFieldPolicy = {
  objectRef: '@test:Product',
  fields: {
    name: {
      fieldName: 'name',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'basic',
      help: 'Public display name',
      label: 'Name',
      order: 1,
      group: null,
      locked: false,
      required: true,
    },
    price: {
      fieldName: 'price',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'advanced',
      help: null,
      label: 'Price',
      order: 2,
      group: 'Pricing',
      locked: false,
      required: false,
    },
    published: {
      fieldName: 'published',
      hasDefault: true,
      defaultValue: false,
      visibility: 'hidden',
      help: null,
      label: 'Published',
      order: 3,
      group: null,
      locked: false,
      required: false,
    },
    metadata: {
      fieldName: 'metadata',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'basic',
      help: null,
      label: 'Metadata',
      order: 4,
      group: null,
      locked: false,
      required: false,
    },
    serverOnly: {
      fieldName: 'serverOnly',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'basic',
      help: null,
      label: 'Server only',
      order: 5,
      group: null,
      locked: false,
      required: false,
    },
  },
};

describe('ObjectForm selection and adapters', () => {
  it('uses only the safe web definition × policy intersection, ordered by policy', () => {
    expect(
      resolveObjectFormFields(fields, policy).map((field) => field.name),
    ).toEqual(['name', 'price', 'published', 'metadata']);
  });

  it('keeps unmapped/action columns while filtering policy-hidden and static hidden columns', () => {
    expect([
      ...policyToVisibleColumnIds(policy, [
        { id: 'name' },
        { id: 'published' },
        { id: 'computed' },
        { id: 'actions' },
        { id: 'metadata', hidden: true },
      ]),
    ]).toEqual(['name', 'computed', 'actions']);
  });

  it('prefers field overrides to type overrides and keeps registries isolated per app', () => {
    const registry = new FieldInputRegistry();
    const text = (() => ({})) as never;
    const field = (() => ({})) as never;
    registry.registerType('text', text);
    registry.registerField('@test:Product', 'name', field);
    expect(registry.resolve('@test:Product', 'name', 'text')).toBe(field);
    expect(registry.resolve('@test:Product', 'other', 'text')).toBe(text);
    expect(
      new FieldInputRegistry().resolve('@test:Product', 'name', 'text'),
    ).toBeUndefined();
  });
});

describe('ObjectForm component', () => {
  it('renders basic fields, omits hidden and non-formable fields, and reveals advanced groups', async () => {
    render(ObjectFormFixture, { props: { fields, policy } });

    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Metadata' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Published' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: 'Price' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Pricing' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Server only')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /Advanced/ }));
    expect(screen.getByRole('group', { name: 'Pricing' })).toBeInTheDocument();
    expect(
      screen.getByRole('spinbutton', { name: 'Price' }),
    ).toBeInTheDocument();
  });

  it('updates the bound create record through built-in text and decimal adapters', async () => {
    render(ObjectFormFixture, { props: { fields, policy } });
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.type(name, 'Deluxe');
    expect(screen.getByTestId('record')).toHaveTextContent('Deluxe');

    await userEvent.click(screen.getByRole('radio', { name: /Advanced/ }));
    await userEvent.type(
      screen.getByRole('spinbutton', { name: 'Price' }),
      '19.5',
    );
    expect(screen.getByTestId('record')).toHaveTextContent('19.5');
  });

  it('seeds policy defaults into create records, including hidden fields', async () => {
    render(ObjectFormFixture, { props: { fields, policy } });
    await tick();
    expect(screen.getByTestId('record')).toHaveTextContent('"published":false');
  });

  it('reapplies defaults after a host resets the bound record for a second create session', async () => {
    render(ObjectFormFixture, { props: { fields, policy } });
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Name' }),
      'First',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Start another record' }),
    );
    await tick();
    expect(screen.getByTestId('record')).toHaveTextContent(
      '{"published":false}',
    );
  });

  it('uses an app registry field override ahead of the built-in type adapter', () => {
    render(ObjectFormRegistryFixture, { props: { fields, policy } });
    expect(
      screen.getByRole('textbox', { name: 'Registry name' }),
    ).toBeInTheDocument();
  });

  it('allows a per-field snippet renderer to replace the resolved input', async () => {
    render(ObjectFormSnippetFixture, { props: { fields, policy } });
    const custom = screen.getByRole('textbox', { name: 'Custom product name' });
    await userEvent.type(custom, 'Custom');
    expect(screen.getByTestId('record')).toHaveTextContent('Custom');
    expect(
      screen.queryByRole('textbox', { name: 'Name' }),
    ).not.toBeInTheDocument();
  });

  it('is axe-clean for its generated basic form', async () => {
    const { container } = render(ObjectFormFixture, {
      props: { fields, policy },
    });
    await expectNoA11yViolations(container);
  });

  it('gives separately mounted forms distinct control and help ids', () => {
    render(ObjectFormFixture, { props: { fields, policy } });
    render(ObjectFormFixture, { props: { fields, policy } });
    const names = screen.getAllByRole('textbox', { name: 'Name' });
    expect(names[0].id).not.toBe(names[1].id);
    expect(names[0].getAttribute('aria-describedby')).not.toBe(
      names[1].getAttribute('aria-describedby'),
    );
  });

  it('surfaces invalid JSON without emitting the stale parsed value', async () => {
    const values: unknown[] = [];
    const validity: boolean[] = [];
    render(FieldInput, {
      props: {
        id: 'payload',
        name: 'payload',
        field: {
          name: 'payload',
          definition: { type: 'json' },
          group: null,
          order: null,
        },
        value: { ok: true },
        required: false,
        disabled: false,
        onvaluechange: (value) => values.push(value),
        onvaliditychange: (valid) => validity.push(valid),
      },
    });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.value = '{bad';
    await fireEvent.input(input);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/valid JSON/i);
    expect(values).toEqual([]);
    expect(validity.at(-1)).toBe(false);
  });

  it('treats an empty optional JSON input as valid and emits undefined', async () => {
    const values: unknown[] = [];
    const validity: boolean[] = [];
    render(FieldInput, {
      props: {
        id: 'payload-empty',
        name: 'payload',
        field: {
          name: 'payload',
          definition: { type: 'json' },
          group: null,
          order: null,
        },
        value: { ok: true },
        required: false,
        disabled: false,
        onvaluechange: (value) => values.push(value),
        onvaliditychange: (valid) => validity.push(valid),
      },
    });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.value = '';
    await fireEvent.input(input);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(values.at(-1)).toBeUndefined();
    expect(validity.at(-1)).toBe(true);
  });

  it('does not emit NaN while a numeric control holds an invalid intermediate value', async () => {
    const values: unknown[] = [];
    render(FieldInput, {
      props: {
        id: 'price',
        name: 'price',
        field: {
          name: 'price',
          definition: { type: 'decimal' },
          group: null,
          order: null,
        },
        value: 12.5,
        required: false,
        disabled: false,
        onvaluechange: (value) => values.push(value),
      },
    });
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    let raw = '1e';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => raw,
      set: (next: string) => {
        raw = next;
      },
    });

    await fireEvent.input(input);
    expect(values).toEqual([]);
  });

  it('does not treat a browser badInput empty number value as a deliberate clear', async () => {
    const values: unknown[] = [];
    render(FieldInput, {
      props: {
        id: 'quantity',
        name: 'quantity',
        field: {
          name: 'quantity',
          definition: { type: 'integer' },
          group: null,
          order: null,
        },
        value: 3,
        required: false,
        disabled: false,
        onvaluechange: (value) => values.push(value),
      },
    });
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    let raw = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => raw,
      set: (next: string) => {
        raw = next;
      },
    });
    Object.defineProperty(input, 'validity', {
      configurable: true,
      value: { badInput: true } as ValidityState,
    });
    await fireEvent.input(input);
    expect(values).toEqual([]);
  });

  it('converts ISO datetimes for datetime-local editing and emits an ISO DTO', async () => {
    const values: unknown[] = [];
    render(FieldInput, {
      props: {
        id: 'starts-at',
        name: 'startsAt',
        field: {
          name: 'startsAt',
          definition: { type: 'datetime' },
          group: null,
          order: null,
        },
        value: '2025-01-02T03:04:00.000Z',
        required: false,
        disabled: false,
        onvaluechange: (value) => values.push(value),
      },
    });
    const input = document.querySelector<HTMLInputElement>('#starts-at');
    if (!input) throw new Error('datetime input missing');
    input.value = '2025-01-03T04:05';
    await fireEvent.input(input);
    expect(values.at(-1)).toMatch(/Z$/);
  });

  it('uses the resolved display label for generated boolean toggle accessibility', () => {
    render(FieldInput, {
      props: {
        id: 'is-published',
        name: 'isPublished',
        label: 'Published publicly',
        field: {
          name: 'isPublished',
          definition: { type: 'boolean' },
          group: null,
          order: null,
        },
        value: false,
        required: false,
        disabled: false,
        onvaluechange: () => undefined,
      },
    });
    expect(
      screen.getByRole('checkbox', { name: 'Published publicly' }),
    ).toBeInTheDocument();
  });

  it('humanizes a generated boolean name when policy has no display label', () => {
    const booleanFields = { isPublished: { type: 'boolean' as const } };
    const booleanPolicy: ResolvedObjectFieldPolicy = {
      objectRef: '@test:Boolean',
      fields: {
        isPublished: {
          fieldName: 'isPublished',
          hasDefault: false,
          defaultValue: undefined,
          visibility: 'basic',
          help: null,
          label: null,
          order: 1,
          group: null,
          locked: false,
          required: false,
        },
      },
    };
    render(ObjectFormFixture, {
      props: { fields: booleanFields, policy: booleanPolicy },
    });
    expect(
      screen.getByRole('checkbox', { name: 'Is Published' }),
    ).toBeInTheDocument();
  });
});

describe('ObjectForm generated source acceptance', () => {
  const productRef = objectRef(AcceptanceProduct);
  const eventRef = objectRef(AcceptanceEvent);
  const productFields: Record<string, ObjectFormFieldDefinition> = {
    name: { type: 'text', required: true },
    price: { type: 'decimal' },
    published: { type: 'boolean' },
  };
  const eventFields: Record<string, ObjectFormFieldDefinition> = {
    title: { type: 'text', required: true },
    startsAt: { type: 'datetime' },
    metadata: { type: 'json' },
  };
  const definitions: ObjectFormCollectionDefinition[] = [
    { objectRef: productRef, fields: productFields },
    { objectRef: eventRef, fields: eventFields },
  ];
  const policies = {
    [productRef]: sourcePolicy(productRef, productFields, { published: false }),
    [eventRef]: sourcePolicy(eventRef, eventFields),
  };

  function createSource(response: unknown = { policies }) {
    const source = new ObjectFormSourceRegistry({
      resolveBatch: vi.fn(async () => response),
    });
    for (const definition of definitions) source.register(definition);
    return source;
  }

  it('drives two REST-exposed decorated objects through one source, including create and edit semantics', async () => {
    const productRegistration =
      ObjectRegistry.getClassByConstructor(AcceptanceProduct);
    const eventRegistration =
      ObjectRegistry.getClassByConstructor(AcceptanceEvent);
    expect(productRegistration?.config.api).toEqual(
      expect.objectContaining({
        include: expect.arrayContaining(['create', 'update']),
      }),
    );
    expect(eventRegistration?.config.api).toEqual(
      expect.objectContaining({
        include: expect.arrayContaining(['create', 'update']),
      }),
    );
    expect(ObjectRegistry.getFields(productRef).get('price')?.type).toBe(
      'decimal',
    );
    expect(ObjectRegistry.getFields(eventRef).get('metadata')?.type).toBe(
      'json',
    );

    const createView = render(ObjectFormSourceSnippetFixture, {
      props: { source: createSource(), objectRef: productRef },
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Custom generated name' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('record')).toHaveTextContent('"published":false');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Custom generated name' }),
      'deluxe',
    );
    expect(screen.getByTestId('record')).toHaveTextContent('"DELUXE"');
    await expectNoA11yViolations(createView.container);
    createView.unmount();

    render(ObjectFormSourceFixture, {
      props: {
        source: createSource(),
        objectRef: eventRef,
        isNewRecord: false,
        initialValue: {
          title: 'Existing event',
          startsAt: '2026-08-08T10:00',
          metadata: { venue: 'Hall A' },
        },
      },
    });
    await vi.waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
        'Existing event',
      ),
    );
    expect(
      (screen.getByRole('textbox', { name: 'Metadata' }) as HTMLTextAreaElement)
        .value,
    ).toContain('Hall A');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated event',
    );
    expect(screen.getByTestId('record')).toHaveTextContent('Updated event');
  });

  it('fails closed with an accessible error for malformed generated action responses', async () => {
    render(ObjectFormSourceFixture, {
      props: {
        source: createSource({
          policies: { [productRef]: { objectRef: eventRef } },
        }),
        objectRef: productRef,
      },
    });
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Invalid ObjectForm source response/,
      ),
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('fails closed with an accessible error for an unregistered objectRef', async () => {
    render(ObjectFormSourceFixture, {
      props: { source: createSource(), objectRef: '@test/missing:Missing' },
    });
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/has no definition/),
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('DataTable policy consumer acceptance', () => {
  it('uses the real DataTable visible-column API without reviving static-hidden columns', () => {
    render(PolicyDataTableFixture, { props: { policy } });
    expect(
      screen.getByRole('columnheader', { name: 'Name' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Published' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Metadata' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Computed' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Actions' }),
    ).toBeInTheDocument();
  });
});
