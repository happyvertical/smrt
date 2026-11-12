import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertMinimalRow,
  buildMinimalRow,
  checkMinimalRowExpectedFailure,
} from '../minimal-row.js';

type Fields = Parameters<
  typeof ObjectRegistry.registerFromManifest
>[1]['fields'];
const packageName = '@test/minimal-row';

function fixture(
  name: string,
  fields: Fields,
  modelConstructor?: typeof SmrtObject,
) {
  const model = `${packageName}:${name}`;
  const parent =
    modelConstructor &&
    ObjectRegistry.getClassByConstructor(
      Object.getPrototypeOf(modelConstructor),
    );
  ObjectRegistry.registerFromManifest(model, {
    name: name.toLowerCase(),
    className: name,
    packageName,
    collection: `minimal_${name.toLowerCase()}`,
    filePath: import.meta.filename,
    extends: parent?.name ?? 'SmrtObject',
    extendsQualified: parent?.qualifiedName,
    fields,
    methods: {},
    decoratorConfig: { tableName: `minimal_${name.toLowerCase()}` },
  });
  expect(ObjectRegistry.hasRuntimeConstructor(model)).toBe(false);
  if (modelConstructor)
    ObjectRegistry.register(modelConstructor, {
      packageName,
      tableName: `minimal_${name.toLowerCase()}`,
    });
  if (modelConstructor)
    expect(ObjectRegistry.hasRuntimeConstructor(model)).toBe(true);
  return model;
}

afterEach(() => ObjectRegistry.clear());

describe('minimal rows', () => {
  it('includes required fields only and honors enums and bounds in metadata', async () => {
    const model = fixture('Shape', {
      choice: { type: 'text', required: true, enum: ['first', 'second'] },
      count: { type: 'integer', _meta: { required: true, min: 3, max: 4 } },
      debt: { type: 'decimal', required: true, min: -5, max: -2 },
      negativeCount: { type: 'integer', required: true, max: -2.2 },
      name: { type: 'text', required: true, minLength: 12, maxLength: 13 },
      enabled: { type: 'boolean', required: true },
      date: { type: 'datetime', required: true },
      data: { type: 'json', required: true },
      tenantId: {
        type: 'text',
        _meta: { __tenancy: { isTenantIdField: true, mode: 'optional' } },
      },
      notes: { type: 'text', default: 'default notes' },
    });
    const row = await buildMinimalRow(model);
    expect(row).toMatchObject({
      choice: 'first',
      count: 3,
      debt: -2,
      negativeCount: -3,
      enabled: false,
      data: {},
    });
    expect(row.name).toHaveLength(13);
    expect(row.date).toBeInstanceOf(Date);
    expect(row).not.toHaveProperty('notes');
    expect(row).not.toHaveProperty('tenantId');
  });

  it('sets required tenant identifiers even when only tenancy metadata requires them', async () => {
    const model = fixture('TenantRow', {
      tenantId: {
        type: 'foreignKey',
        related: 'Tenant',
        _meta: {
          sqlType: 'UUID',
          __tenancy: { isTenantIdField: true, mode: 'required' },
        },
      },
    });
    expect((await buildMinimalRow(model)).tenantId).toMatch(/^[\da-f-]{36}$/);
  });

  it('rejects impossible bounds with the model and field', async () => {
    const model = fixture('BadBounds', {
      count: { type: 'integer', required: true, min: 0.1, max: 0.2 },
    });
    await expect(buildMinimalRow(model)).rejects.toThrow(
      /Model .*BadBounds: required field count/,
    );
  });

  it('creates required parents on the supplied database before building the child', async () => {
    class Parent extends SmrtObject {
      name = '';
      tenantId = '';
    }
    const parent = fixture(
      'Parent',
      {
        name: { type: 'text', required: true },
        tenantId: {
          type: 'text',
          required: true,
          _meta: { __tenancy: { isTenantIdField: true, mode: 'required' } },
        },
      },
      Parent,
    );
    const child = fixture('Child', {
      tenantId: {
        type: 'text',
        required: true,
        _meta: { __tenancy: { isTenantIdField: true, mode: 'required' } },
      },
      parentId: { type: 'foreignKey', required: true, related: parent },
    });
    await expect(buildMinimalRow(child)).rejects.toThrow(
      /required field parentId.*database/,
    );
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [parent, child],
    });
    try {
      const row = await buildMinimalRow(child, { db });
      const parents = await ObjectRegistry.getCollection(parent, { db });
      const savedParent = await parents.get({ id: row.parentId as string });
      expect(savedParent).not.toBeNull();
      expect((savedParent as unknown as { tenantId: string }).tenantId).toBe(
        row.tenantId,
      );
    } finally {
      await db.close?.();
    }
  });

  it('shares optional parent tenancy and ancestor identities without populating root optionals', async () => {
    class Owner extends SmrtObject {
      tenantId: string | null = null;
    }
    class Revision extends SmrtObject {
      ownerId = '';
    }
    const owner = fixture(
      'Owner',
      {
        tenantId: {
          type: 'text',
          _meta: { __tenancy: { isTenantIdField: true, mode: 'optional' } },
        },
      },
      Owner,
    );
    const revision = fixture(
      'Revision',
      {
        ownerId: { type: 'foreignKey', required: true, related: owner },
      },
      Revision,
    );
    const child = fixture('Graph', {
      tenantId: {
        type: 'text',
        required: true,
        _meta: { __tenancy: { isTenantIdField: true, mode: 'required' } },
      },
      ownerId: { type: 'foreignKey', required: true, related: owner },
      otherOwnerId: { type: 'foreignKey', required: true, related: owner },
      revisionId: { type: 'foreignKey', required: true, related: revision },
    });
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [owner, revision, child],
    });
    try {
      const row = await buildMinimalRow(child, { db });
      const owners = await ObjectRegistry.getCollection(owner, { db });
      const revisions = await ObjectRegistry.getCollection(revision, { db });
      expect(await owners.get({ id: row.ownerId as string })).toMatchObject({
        tenantId: row.tenantId,
      });
      expect(
        await revisions.get({ id: row.revisionId as string }),
      ).toMatchObject({ ownerId: row.ownerId });
      expect(await owners.list({})).toHaveLength(2);
      expect(row.otherOwnerId).not.toBe(row.ownerId);
      expect(await buildMinimalRow(owner, { db })).not.toHaveProperty(
        'tenantId',
      );
      const other = await buildMinimalRow(child, { db });
      expect(other.ownerId).not.toBe(row.ownerId);
      expect(other.tenantId).not.toBe(row.tenantId);
    } finally {
      await db.close?.();
    }
  });

  it('round trips a real constructor with empty optional fields', async () => {
    class Healthy extends SmrtObject {
      name = '';
      notes = '';
      enabled = false;
      derived = '';
      override async initialize() {
        await super.initialize();
        this.derived = this.name;
        return this;
      }
    }
    const model = fixture(
      'Healthy',
      {
        name: { type: 'text', required: true },
        notes: { type: 'text' },
        enabled: { type: 'boolean' },
        derived: { type: 'text' },
      },
      Healthy,
    );
    await expect(assertMinimalRow(model)).resolves.toBeUndefined();
  });

  it('uses constructor defaults, including clock-based dates, and saves append-only rows once', async () => {
    class AppendOnly extends SmrtObject {
      occurredAt = new Date();
      expiresAt = new Date(Date.now() + 600_000);
      status = 'open';
      override async save() {
        if (this.isPersisted) throw new Error('append-only row');
        return super.save();
      }
    }
    const model = fixture(
      'AppendOnly',
      {
        occurredAt: { type: 'datetime' },
        expiresAt: { type: 'datetime' },
        status: { type: 'text', default: 'open' },
      },
      AppendOnly,
    );
    await expect(assertMinimalRow(model)).resolves.toBeUndefined();
  });

  it('includes inherited required fields without populating inherited optional fields', async () => {
    class ParentShape extends SmrtObject {
      name = '';
      notes = '';
    }
    fixture(
      'ParentShape',
      { name: { type: 'text', required: true }, notes: { type: 'text' } },
      ParentShape,
    );
    class DerivedShape extends ParentShape {
      count = 0;
    }
    const model = fixture(
      'DerivedShape',
      { count: { type: 'integer', required: true } },
      DerivedShape,
    );
    expect(await buildMinimalRow(model)).toEqual({ name: 'minimal', count: 1 });
  });

  it('reports required foreign-key cycles with the offending field and full path', async () => {
    class Cycle extends SmrtObject {
      parentId = '';
    }
    const model = fixture(
      'Cycle',
      {
        parentId: {
          type: 'foreignKey',
          related: `${packageName}:Cycle`,
          required: true,
        },
      },
      Cycle,
    );
    const db = await getTestDatabase({ type: 'sqlite', classes: [model] });
    try {
      await expect(buildMinimalRow(model, { db })).rejects.toThrow(
        /required field parentId.*required foreign-key cycle/,
      );
    } finally {
      await db.close?.();
    }
  });

  it('names an optional field that a model quietly requires, and rejects stale expected failures', async () => {
    class Broken extends SmrtObject {
      notes = '';
      override async save() {
        if (!this.notes) throw new Error('missing value');
        return super.save();
      }
    }
    const model = fixture('Broken', { notes: { type: 'text' } }, Broken);
    await expect(assertMinimalRow(model)).rejects.toThrow(
      `Model ${model}: optional field notes`,
    );
    const expected = {
      model,
      field: 'notes',
      reason: 'Regression fixture requires optional input',
      error: 'missing value',
    };
    await expect(
      checkMinimalRowExpectedFailure(model, expected),
    ).resolves.toBeUndefined();
    await expect(
      checkMinimalRowExpectedFailure(model, expected, async () => {}),
    ).rejects.toThrow(/now passes; remove this entry/);
    await expect(
      checkMinimalRowExpectedFailure(model, { ...expected, field: 'other' }),
    ).rejects.toThrow(/optional field notes/);
    await expect(
      checkMinimalRowExpectedFailure(model, {
        ...expected,
        error: 'different defect',
      }),
    ).rejects.toThrow(/optional field notes/);
  });

  it('keeps service-only and domain-value findings shrink-only and error-specific', async () => {
    const model = fixture('Domain', { key: { type: 'text', required: true } });
    for (const kind of ['service-only', 'needs-domain-value'] as const) {
      const expected = {
        model,
        kind,
        field: kind === 'service-only' ? '(service-only write)' : 'key',
        reason: 'Owned contract',
        error: 'precise refusal',
      };
      await expect(
        checkMinimalRowExpectedFailure(model, expected, async () => {
          throw new Error('precise refusal');
        }),
      ).resolves.toBeUndefined();
      await expect(
        checkMinimalRowExpectedFailure(model, expected, async () => {}),
      ).rejects.toThrow(/now passes; remove/);
      await expect(
        checkMinimalRowExpectedFailure(model, expected, async () => {
          throw new Error('different refusal');
        }),
      ).rejects.toThrow('different refusal');
    }
  });

  it('matches combined optional guards without treating required fields as optional', async () => {
    const model = fixture('Combined', {
      code: { type: 'text' },
      name: { type: 'text' },
      key: { type: 'text', required: true },
    });
    const expected = {
      model,
      field: 'code, name',
      reason: 'Both optional fields are required by one guard',
      error: 'code and name required',
    };
    const run = async () => {
      throw new Error('code and name required');
    };
    await expect(
      checkMinimalRowExpectedFailure(model, expected, run),
    ).resolves.toBeUndefined();
    await expect(
      checkMinimalRowExpectedFailure(model, { ...expected, field: 'key' }, run),
    ).rejects.toThrow('code and name required');
    await expect(
      checkMinimalRowExpectedFailure(
        model,
        { ...expected, field: 'missing' },
        run,
      ),
    ).rejects.toThrow('code and name required');
  });

  it('rejects populated optional data after save and hydration', async () => {
    class Mutating extends SmrtObject {
      notes = '';
      override async save() {
        this.notes = 'secret dependency';
        return super.save();
      }
    }
    const model = fixture('Mutating', { notes: { type: 'text' } }, Mutating);
    await expect(assertMinimalRow(model)).rejects.toThrow(
      /optional field notes read back populated/,
    );
  });
});
