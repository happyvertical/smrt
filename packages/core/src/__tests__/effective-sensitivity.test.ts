/**
 * #5196: run-time model marker and effective sensitivity, the inputs of the
 * guest caller ceiling.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import {
  isEffectivelySensitiveClass,
  isRuntimeModelClass,
} from '../effective-sensitivity.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { registerRuntimeModel } from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

@smrt({ tableName: 'es5196_plain' })
class Plain5196 extends SmrtObject {
  @field() title = '';
}

@smrt({ tableName: 'es5196_flagged', sensitive: true })
class Flagged5196 extends SmrtObject {
  @field() title = '';
}

@smrt({ tableName: 'es5196_secretive' })
class Secretive5196 extends SmrtObject {
  @field({ sensitive: true }) secret = '';
}

@smrt({ tableName: 'es5196_child' })
class Child5196 extends Secretive5196 {
  @field() note = '';
}

@smrt({ tableName: 'es5196_flagged_child' })
class FlaggedChild5196 extends Flagged5196 {
  @field() note = '';
}

const qn = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor)!.qualifiedName!;

describe('effective sensitivity and run-time marker (#5196)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('a plain class is not sensitive and not a run-time model', () => {
    expect(isEffectivelySensitiveClass(qn(Plain5196))).toBe(false);
    expect(isRuntimeModelClass(qn(Plain5196))).toBe(false);
  });

  it('a class flagged sensitive is sensitive, and so is a subclass', () => {
    expect(isEffectivelySensitiveClass(qn(Flagged5196))).toBe(true);
    expect(isEffectivelySensitiveClass(qn(FlaggedChild5196))).toBe(true);
  });

  it('a sensitive field makes the class and its subclasses sensitive', () => {
    expect(isEffectivelySensitiveClass(qn(Secretive5196))).toBe(true);
    expect(isEffectivelySensitiveClass(qn(Child5196))).toBe(true);
  });

  it('a credential table by name is sensitive', () => {
    @smrt({ tableName: 'sessions' })
    class SessionLike5196 extends SmrtObject {
      @field() title = '';
    }
    expect(isEffectivelySensitiveClass(qn(SessionLike5196))).toBe(true);
  });

  it('an unknown class counts as sensitive', () => {
    expect(isEffectivelySensitiveClass('@nowhere/x:Missing')).toBe(true);
  });

  it('registerRuntimeModel marks the registry entry', () => {
    const q = registerRuntimeModel({
      name: 'Chore5196',
      packageName: '@test/es5196',
      fields: { title: { type: 'text' } },
    });
    expect(isRuntimeModelClass(q)).toBe(true);
    expect(ObjectRegistry.getClass(q)?.runtimeModel).toBe(true);
    expect(isEffectivelySensitiveClass(q)).toBe(false);
  });

  it('a run-time model with a sensitive field is sensitive', () => {
    const q = registerRuntimeModel({
      name: 'Vault5196',
      packageName: '@test/es5196',
      fields: { token: { type: 'text', sensitive: true } },
    });
    expect(isEffectivelySensitiveClass(q)).toBe(true);
  });
});
