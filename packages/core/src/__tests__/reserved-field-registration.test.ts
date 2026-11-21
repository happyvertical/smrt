/**
 * Field registration rejects names the object runtime already uses (instance
 * members, prototype methods and accessors, constructor flags). The rule is
 * shared with the scanner (`@happyvertical/smrt-scanner/types`), so a
 * decorated class and a scanned model fail the same way. The decorators are
 * applied by hand so the test manifest scan does not see the reserved names.
 */
import { describe, expect, it } from 'vitest';
import { field, foreignKey, meta } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';

class ReservedRegistrationShelf extends SmrtObject {}
class ReservedRegistrationTarget extends SmrtObject {}

function applyField(decorator: unknown, name: string): void {
  (decorator as (target: object, key: string) => void)(
    ReservedRegistrationShelf.prototype,
    name,
  );
}

describe('field registration of reserved names', () => {
  const reserved = [
    'options',
    'db',
    'ai',
    'save',
    'toJSON',
    '_db',
    '_skipLoad',
  ];
  it('rejects a reserved @field name with the model, the field and the fix', () => {
    for (const name of reserved) {
      expect(() => applyField(field({ type: 'text' }), name)).toThrow(
        new RegExp(
          `Model ReservedRegistrationShelf declares a field named "${name}".*Rename the field`,
        ),
      );
      expect(
        ObjectRegistry.getFieldDecorator('ReservedRegistrationShelf', name),
      ).toBeUndefined();
    }
  });

  it('rejects reserved names on every field decorator, not only @field', () => {
    expect(() => applyField(meta(), 'fs')).toThrow(/"fs"/);
    expect(() =>
      applyField(foreignKey(ReservedRegistrationTarget), 'tableName'),
    ).toThrow(/"tableName"/);
  });

  it('still registers ordinary names, SQL words and service-option names', () => {
    for (const name of ['key', 'order', 'optionsList', 'metrics', 'logging']) {
      expect(() => applyField(field({ type: 'text' }), name)).not.toThrow();
      expect(
        ObjectRegistry.getFieldDecorator('ReservedRegistrationShelf', name),
      ).toMatchObject({ type: 'text' });
    }
  });
});
