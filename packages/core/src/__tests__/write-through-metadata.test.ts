import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
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
  @field() tenantId: string | null = null;
}
@smrt({ writeThrough: { contactId: { fields: ['name'] } } })
class InlineRequiredRecord extends SmrtObject {
  @foreignKey(InlineRequiredContact, {
    required: true,
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
  })
  contactId = '';
  @field() tenantId: string | null = null;
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
