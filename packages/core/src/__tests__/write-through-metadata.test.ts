import { assert, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { ManifestGenerator } from '../scanner/manifest-generator';
import type { FieldDefinition, SmartObjectManifest } from '../scanner/types';
import { getTestDatabase } from '../testing/database';
import { writeThroughFields } from '../write-through';

const fields = {
  profileId: { type: 'crossPackageRef', related: '@test:Profile' },
} satisfies Record<string, FieldDefinition>;
describe('write-through declarations', () => {
  it('projects declared writable fields without making duplicate persisted columns', () => {
    expect(
      writeThroughFields(fields, { profileId: { fields: ['name'] } }, () => ({
        name: { type: 'text', required: true },
      })),
    ).toMatchObject({
      name: { type: 'text', required: false, _meta: { ui: { basic: true } } },
    });
    expect(fields).not.toHaveProperty('name');
  });
  it.each([
    'id',
    'tenantId',
    'displayLabel',
    '__proto__',
    'profileId',
  ])('refuses reserved or colliding field %s', (name) => {
    expect(() =>
      writeThroughFields(fields, { profileId: { fields: [name] } }, () => ({
        [name]: { type: 'text' },
      })),
    ).toThrow();
  });
  it.each([
    { sensitive: true },
    { readonly: true },
    { transient: true },
    { readPermission: 'private.read' },
    { _meta: { sensitive: true } },
  ])('refuses a protected target field %j', (extra) => {
    expect(() =>
      writeThroughFields(fields, { profileId: { fields: ['name'] } }, () => ({
        name: { type: 'text', ...extra },
      })),
    ).toThrow();
  });
});

@smrt()
class InlineRequiredContact extends SmrtObject {
  @field({ required: true }) name = '';
  @field({ nullable: true }) email: string | null = null;
  @field({ nullable: true }) phoneValue: string | null = null;
  @field() tenantId: string | null = null;
}
@smrt({
  writeThrough: {
    contactId: {
      fields: ['name', 'email'],
      virtualFields: { phone: { type: 'text' } },
    },
  },
})
class InlineRequiredRecord extends SmrtObject {
  @foreignKey(InlineRequiredContact, {
    required: true,
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
  })
  contactId = '';
  @field() tenantId: string | null = null;

  protected override async saveWriteThroughVirtual(
    _via: string,
    target: SmrtObject,
    values: Record<string, unknown>,
  ): Promise<void> {
    if (Object.hasOwn(values, 'phone')) {
      (target as InlineRequiredContact).phoneValue =
        (values.phone as string | null | undefined) ?? null;
      await target.save();
    }
  }
}
class InlineRequiredRecords extends SmrtCollection<InlineRequiredRecord> {
  static readonly _itemClass = InlineRequiredRecord;
}
for (const type of ['sqlite', 'duckdb'] as const) {
  it(`creates a required linked record before validating the source reference (${type})`, async () => {
    const db = await getTestDatabase({
      type,
      url: ':memory:',
      classes: ['InlineRequiredContact', 'InlineRequiredRecord'],
    });
    try {
      const records = await InlineRequiredRecords.create({ db });
      const input = { name: 'Inline person' };
      const record = await records.create({ ...input, _skipLoad: true });
      expect(record.contactId).toBeTruthy();
      expect(
        (
          await db.query(
            'SELECT name FROM inline_required_contacts WHERE id = ?',
            record.contactId,
          )
        ).rows[0].name,
      ).toBe('Inline person');
    } finally {
      await db.close?.();
    }
  });
}

it('includes virtual linked fields in generated client DTOs without adding persistence fields', () => {
  const fields = { contactId: { type: 'text' } };
  const manifest = {
    objects: {
      InlineDto: {
        className: 'InlineDto',
        fields,
        methods: {},
        writeThroughFields: { name: { type: 'text', required: false } },
      },
    },
  } as unknown as SmartObjectManifest;
  expect(new ManifestGenerator().generateTypeDefinitions(manifest)).toContain(
    'name?: string;',
  );
  expect(fields).not.toHaveProperty('name');
});

describe('persisted write-through selection and clearing', () => {
  it.each([
    {
      inlineField: 'email',
      value: 'stale@example.test',
      tenantId: null,
      error: 'Choose an existing record without inline edits',
    },
    {
      inlineField: 'phone',
      value: 'stale phone',
      tenantId: null,
      error: 'Choose an existing record without inline edits',
    },
    {
      inlineField: 'email',
      value: '',
      tenantId: 'other-tenant',
      error: 'Write-through edits require the same tenant',
    },
    {
      inlineField: 'phone',
      value: '',
      tenantId: 'other-tenant',
      error: 'Write-through edits require the same tenant',
    },
  ])('rejects relink with $inlineField=$value and tenant=$tenantId', async ({
    inlineField,
    value,
    tenantId,
    error,
  }) => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['InlineRequiredContact', 'InlineRequiredRecord'],
    });
    try {
      const contacts = await ObjectRegistry.getCollection(
        'InlineRequiredContact',
        { db },
      );
      const records = await InlineRequiredRecords.create({ db });
      const original = await contacts.create({
        name: 'Original',
        email: 'original@example.test',
        phoneValue: '111',
      });
      const selected = await contacts.create({
        name: 'Selected',
        email: 'selected@example.test',
        phoneValue: '222',
        tenantId,
      });
      assert(original.id);
      assert(selected.id);
      const created = await records.create({ contactId: original.id });
      assert(created.id);
      const record = await records.get(created.id, { cache: false });
      assert(record);
      record.contactId = selected.id;
      (record as unknown as Record<string, unknown>)[inlineField] = value;
      await expect(record.save()).rejects.toMatchObject({
        cause: { message: expect.stringContaining(error) },
      });
      expect((await records.get(created.id, { cache: false }))?.contactId).toBe(
        original.id,
      );
      expect(
        (await contacts.get(selected.id, { cache: false }))?.toJSON(),
      ).toMatchObject({ email: 'selected@example.test', phoneValue: '222' });
      expect(
        (await contacts.get(original.id, { cache: false }))?.toJSON(),
      ).toMatchObject({ email: 'original@example.test', phoneValue: '111' });
    } finally {
      await db.close?.();
    }
  });
  for (const inlineField of ['email', 'phone'] as const) {
    for (const blank of ['', null, undefined]) {
      it(`preserves target ${inlineField} on relink with ${String(blank)} inline input`, async () => {
        const db = await getTestDatabase({
          type: 'sqlite',
          url: ':memory:',
          classes: ['InlineRequiredContact', 'InlineRequiredRecord'],
        });
        try {
          const contacts = await ObjectRegistry.getCollection(
            'InlineRequiredContact',
            { db },
          );
          const records = await InlineRequiredRecords.create({ db });
          const original = await contacts.create({
            name: 'Original',
            email: 'original@example.test',
            phoneValue: '111',
          });
          const selected = await contacts.create({
            name: 'Selected',
            email: 'selected@example.test',
            phoneValue: '222',
          });
          assert(original.id);
          assert(selected.id);
          const created = await records.create({ contactId: original.id });
          assert(created.id);
          const record = await records.get(created.id, {
            cache: false,
          });
          expect(record).not.toBeNull();
          assert(record);
          record.contactId = selected.id;
          (record as unknown as Record<string, unknown>)[inlineField] = blank;
          await record.save();
          const reloaded = await records.get(created.id, {
            cache: false,
          });
          expect(reloaded?.contactId).toBe(selected.id);
          expect(
            (
              await contacts.get(selected.id, {
                cache: false,
              })
            )?.toJSON(),
          ).toMatchObject({
            email: 'selected@example.test',
            phoneValue: '222',
          });
          expect(
            (
              await contacts.get(original.id, {
                cache: false,
              })
            )?.toJSON(),
          ).toMatchObject({
            email: 'original@example.test',
            phoneValue: '111',
          });
        } finally {
          await db.close?.();
        }
      });
    }

    it(`allows intentional clearing of the current linked ${inlineField}`, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: ['InlineRequiredContact', 'InlineRequiredRecord'],
      });
      try {
        const records = await InlineRequiredRecords.create({ db });
        const created = await records.create({
          name: 'Current',
          email: 'current@example.test',
          phone: '333',
        });
        assert(created.id);
        const record = await records.get(created.id, {
          cache: false,
        });
        assert(record);
        (record as unknown as Record<string, unknown>)[inlineField] = '';
        await record.save();
        const contacts = await ObjectRegistry.getCollection(
          'InlineRequiredContact',
          { db },
        );
        const target = await contacts.get(created.contactId, { cache: false });
        expect(target?.toJSON()).toMatchObject(
          inlineField === 'email'
            ? { email: '', phoneValue: '333' }
            : { email: 'current@example.test', phoneValue: '' },
        );
      } finally {
        await db.close?.();
      }
    });
  }
});
