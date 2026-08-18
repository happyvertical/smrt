/**
 * Regression tests for issue #2379 — arrow-thunk relationship targets.
 *
 * `@foreignKey(() => Target)` used to register `related: ''` because an inline
 * arrow's `.name` is the empty string. The field kept `type: 'foreignKey'` but
 * lost its target, so the registry emitted no relationship edge, `loadRelated()`
 * had nothing to resolve, and the schema path emitted no FK reference (and,
 * once FK columns are indexed, no index).
 *
 * The decorators now resolve the thunk, and an unresolvable target throws at
 * decoration time instead of silently registering an empty `related`.
 *
 * The first block applies the decorators directly to a prototype so the
 * assertions cover the decorator path alone — a decorated `@smrt()` class also
 * receives `related` from its scanned manifest, which would mask a decorator
 * regression.
 *
 * @see https://github.com/happyvertical/smrt/issues/2379
 */

import { describe, expect, it } from 'vitest';
import {
  foreignKey,
  manyToMany,
  oneToMany,
  SmrtObject,
  smrt,
} from '../index.js';
import { ObjectRegistry } from '../registry.js';
import { SchemaGenerator } from '../schema/generator.js';

@smrt()
class ThunkFkTarget extends SmrtObject {
  name: string = '';
}

@smrt()
class ThunkFkSource extends SmrtObject {
  // Forward-reference thunk — the form that used to register `related: ''`.
  @foreignKey(() => ThunkFkTarget)
  targetId: string | null = null;
}

@smrt()
class ThunkSelfRef extends SmrtObject {
  // Self-reference: resolution runs at field-registration time, after the
  // class binding exists, so the thunk must not hit the temporal dead zone.
  @foreignKey(() => ThunkSelfRef)
  parentId: string | null = null;
}

describe('issue #2379: relationship decorators resolve arrow-thunk targets', () => {
  it('registers the target class name for a `() => Target` foreign key', () => {
    class ThunkDecoratorProbe {}
    foreignKey(() => ThunkFkTarget)(
      ThunkDecoratorProbe.prototype,
      'thunkTargetId',
    );

    expect(
      ObjectRegistry.getFieldDecorator('ThunkDecoratorProbe', 'thunkTargetId'),
    ).toMatchObject({ type: 'foreignKey', related: 'ThunkFkTarget' });
  });

  it('resolves thunk, class and string forms to the same target', () => {
    class ThunkFormProbe {}
    foreignKey(() => ThunkFkTarget)(ThunkFormProbe.prototype, 'thunkTargetId');
    foreignKey(ThunkFkTarget)(ThunkFormProbe.prototype, 'directTargetId');
    foreignKey('ThunkFkTarget')(ThunkFormProbe.prototype, 'stringTargetId');

    const decorators = ObjectRegistry.getFieldDecorators('ThunkFormProbe');
    expect(decorators.get('thunkTargetId')?.related).toBe('ThunkFkTarget');
    expect(decorators.get('directTargetId')?.related).toBe('ThunkFkTarget');
    expect(decorators.get('stringTargetId')?.related).toBe('ThunkFkTarget');
  });

  it('resolves a named thunk to its target, not to the variable name', () => {
    const lazyTarget = () => ThunkFkTarget;
    class NamedThunkProbe {}
    foreignKey(lazyTarget)(NamedThunkProbe.prototype, 'targetId');

    // `lazyTarget.name` is 'lazyTarget'; arrow functions have no prototype, so
    // the resolver invokes it rather than registering the variable name.
    expect(
      ObjectRegistry.getFieldDecorator('NamedThunkProbe', 'targetId')?.related,
    ).toBe('ThunkFkTarget');
  });

  it('resolves thunk targets for oneToMany and manyToMany', () => {
    class ThunkCollectionProbe {}
    oneToMany(() => ThunkFkSource)(ThunkCollectionProbe.prototype, 'sources');
    manyToMany(() => ThunkFkTarget, { through: 'thunk_probe_targets' })(
      ThunkCollectionProbe.prototype,
      'targets',
    );

    const decorators = ObjectRegistry.getFieldDecorators(
      'ThunkCollectionProbe',
    );
    expect(decorators.get('sources')).toMatchObject({
      type: 'oneToMany',
      related: 'ThunkFkSource',
    });
    expect(decorators.get('targets')).toMatchObject({
      type: 'manyToMany',
      related: 'ThunkFkTarget',
    });
  });

  it('populates relationship metadata for a thunk-declared foreign key', () => {
    const relationship = ObjectRegistry.getRelationships('ThunkFkSource').find(
      (candidate) => candidate.fieldName === 'targetId',
    );

    expect(relationship).toBeDefined();
    expect(relationship?.type).toBe('foreignKey');
    expect(relationship?.targetClass).toBe('ThunkFkTarget');
  });

  it('emits the FK reference on the registry schema path', () => {
    const registered = ObjectRegistry.getClass('ThunkFkSource');
    expect(registered).toBeDefined();
    if (!registered) return;

    const schema = new SchemaGenerator().generateSchemaFromRegistry(
      'ThunkFkSource',
      'thunk_fk_sources',
      registered.fields,
    );

    // A resolvable target is what makes this a real foreign key column — the
    // FK-derived index rollout (#2359) keys off exactly this metadata.
    expect(schema.columns.target_id?.foreignKey).toEqual(
      expect.objectContaining({ table: 'thunk_fk_targets', column: 'id' }),
    );
  });

  it('resolves a self-referential thunk without a temporal dead zone error', () => {
    const relationship = ObjectRegistry.getRelationships('ThunkSelfRef').find(
      (candidate) => candidate.fieldName === 'parentId',
    );

    expect(relationship?.targetClass).toBe('ThunkSelfRef');
  });
});

describe('issue #2379: unresolvable relationship targets throw', () => {
  it('throws when the thunk itself throws', () => {
    class ThunkThrowsProbe {}

    expect(() =>
      foreignKey(() => {
        throw new Error('target module not initialized');
      })(ThunkThrowsProbe.prototype, 'targetId'),
    ).toThrow(/ThunkThrowsProbe\.targetId/);
  });

  it('names the string form as the remedy when the thunk throws', () => {
    class ThunkRemedyProbe {}

    expect(() =>
      foreignKey(() => {
        throw new Error('target module not initialized');
      })(ThunkRemedyProbe.prototype, 'targetId'),
    ).toThrow(/@foreignKey\('Target'\)/);
  });

  it('throws when the thunk target is declared later and still in its TDZ', () => {
    class TdzProbe {}

    // The documented limitation of resolving at decoration time: a thunk
    // pointing at a class declared later in the same module cannot resolve, so
    // it fails loudly and names the string form rather than registering an
    // empty target.
    expect(() =>
      foreignKey(() => DeclaredLater)(TdzProbe.prototype, 'targetId'),
    ).toThrow(/TdzProbe\.targetId.*@foreignKey\('Target'\)/s);

    class DeclaredLater extends SmrtObject {}
    void DeclaredLater;
  });

  it('throws when the thunk resolves to an anonymous value', () => {
    class ThunkAnonymousProbe {}

    expect(() =>
      foreignKey(() => undefined)(ThunkAnonymousProbe.prototype, 'targetId'),
    ).toThrow(/ThunkAnonymousProbe\.targetId/);
  });

  it("throws on an empty target name instead of registering `related: ''`", () => {
    class EmptyTargetProbe {}

    expect(() =>
      foreignKey('   ')(EmptyTargetProbe.prototype, 'targetId'),
    ).toThrow(/EmptyTargetProbe\.targetId/);
  });

  it('throws when the target is not a class, name, or thunk', () => {
    class UndefinedTargetProbe {}

    // Simulates a circular import that resolved to `undefined` at decoration
    // time — previously a bare TypeError on `.name`.
    expect(() =>
      foreignKey(undefined as unknown as string)(
        UndefinedTargetProbe.prototype,
        'targetId',
      ),
    ).toThrow(/UndefinedTargetProbe\.targetId/);
  });

  it('never leaves an empty `related` behind for a rejected target', () => {
    class RejectedTargetProbe {}

    expect(() =>
      foreignKey(() => undefined)(RejectedTargetProbe.prototype, 'targetId'),
    ).toThrow();

    expect(
      ObjectRegistry.getFieldDecorator('RejectedTargetProbe', 'targetId'),
    ).toBeUndefined();
  });

  it('rejects the same unresolvable targets for oneToMany and manyToMany', () => {
    class RelationRejectProbe {}

    expect(() =>
      oneToMany(() => undefined)(RelationRejectProbe.prototype, 'items'),
    ).toThrow(/@oneToMany\('Target'\)/);
    expect(() =>
      manyToMany(() => undefined)(RelationRejectProbe.prototype, 'tags'),
    ).toThrow(/@manyToMany\('Target'\)/);
  });
});
