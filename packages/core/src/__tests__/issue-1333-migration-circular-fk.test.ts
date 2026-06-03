/**
 * Regression test for issue #1333: db:migrate aborts on a pre-existing FK cycle.
 *
 * A genuine same-package foreign-key cycle (e.g. smrt-chat's
 * ChatMessage.threadId -> ChatThread and ChatThread.rootMessageId ->
 * ChatMessage) must not abort schema ordering. SMRT does not emit real DB
 * FOREIGN KEY constraints in its CREATE TABLE DDL, so a cycle has no valid
 * strict topological order — the ordering must BREAK the back-edge (standard
 * RDBMS approach: create tables first, wire cyclic references afterward)
 * instead of throwing.
 *
 * Two facets are covered:
 *   1. A fresh cyclic pair must produce a usable initialization order that
 *      contains BOTH tables (cycle broken, not aborted).
 *   2. An additive migration whose pending changes are unrelated to the cyclic
 *      tables must not trip on the pre-existing cycle when the full registered
 *      graph is ordered.
 *
 * @see https://github.com/happyvertical/smrt/issues/1333
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import type { FieldDefinition } from '../scanner/types.js';

// Minimal field stub mirroring registry.test.ts's helper: `related` is a
// top-level property (not nested in _meta), matching how the scanner records
// foreignKey targets.
class StubField implements FieldDefinition {
  type: FieldDefinition['type'];
  _meta: Record<string, any>;
  related?: string;

  constructor(
    type: FieldDefinition['type'],
    options: Record<string, any> = {},
  ) {
    this.type = type;
    if (options.related) {
      this.related = options.related;
      const { related, ...metaOptions } = options;
      this._meta = metaOptions;
    } else {
      this._meta = options;
    }
  }
}

function registerWithFields(
  ctor: typeof SmrtObject,
  fields: Map<string, FieldDefinition>,
): void {
  ObjectRegistry.register(ctor, {
    api: { include: ['list', 'get'] },
  });
  const registered = ObjectRegistry.getClass(ctor.name);
  if (registered) {
    registered.fields = fields;
  }
}

describe('Issue #1333: FK cycles must not abort migration ordering', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('breaks a two-class FK cycle instead of throwing (fresh create)', () => {
    // class CycleNodeA { @foreignKey('CycleNodeB') bId }
    // class CycleNodeB { @foreignKey('CycleNodeA') aId }
    class CycleNodeA extends SmrtObject {}
    class CycleNodeB extends SmrtObject {}

    registerWithFields(
      CycleNodeA,
      new Map<string, FieldDefinition>([
        ['bId', new StubField('foreignKey', { related: 'CycleNodeB' })],
      ]),
    );
    registerWithFields(
      CycleNodeB,
      new Map<string, FieldDefinition>([
        ['aId', new StubField('foreignKey', { related: 'CycleNodeA' })],
      ]),
    );

    // The dependency graph reflects the genuine cycle.
    const graph = ObjectRegistry.getDependencyGraph();
    expect(graph.get('CycleNodeA')).toContain('CycleNodeB');
    expect(graph.get('CycleNodeB')).toContain('CycleNodeA');

    // Ordering must NOT throw — it breaks the back-edge instead.
    let order: string[] = [];
    expect(() => {
      order = ObjectRegistry.getInitializationOrder();
    }).not.toThrow();

    // Both tables must still appear so both get created.
    expect(order).toContain('CycleNodeA');
    expect(order).toContain('CycleNodeB');
  });

  it('handles a self-referential class participating in a cycle', () => {
    // Mirrors ChatMessage: a cyclic FK plus a self-ref.
    class CycleSelfA extends SmrtObject {}
    class CycleSelfB extends SmrtObject {}

    registerWithFields(
      CycleSelfA,
      new Map<string, FieldDefinition>([
        ['bId', new StubField('foreignKey', { related: 'CycleSelfB' })],
        ['parentId', new StubField('foreignKey', { related: 'CycleSelfA' })],
      ]),
    );
    registerWithFields(
      CycleSelfB,
      new Map<string, FieldDefinition>([
        ['aId', new StubField('foreignKey', { related: 'CycleSelfA' })],
      ]),
    );

    let order: string[] = [];
    expect(() => {
      order = ObjectRegistry.getInitializationOrder();
    }).not.toThrow();
    expect(order).toContain('CycleSelfA');
    expect(order).toContain('CycleSelfB');
  });

  it('does not abort when an unrelated additive change coexists with a pre-existing cycle', () => {
    // Pre-existing cyclic pair (e.g. ChatMessage <-> ChatThread already in DB).
    class PreexistingCycleA extends SmrtObject {}
    class PreexistingCycleB extends SmrtObject {}
    registerWithFields(
      PreexistingCycleA,
      new Map<string, FieldDefinition>([
        ['bId', new StubField('foreignKey', { related: 'PreexistingCycleB' })],
      ]),
    );
    registerWithFields(
      PreexistingCycleB,
      new Map<string, FieldDefinition>([
        ['aId', new StubField('foreignKey', { related: 'PreexistingCycleA' })],
      ]),
    );

    // An unrelated NEW acyclic table (the actual pending change), plus one of
    // its dependencies, both outside the cycle.
    class NewParent extends SmrtObject {}
    class NewChild extends SmrtObject {}
    registerWithFields(NewParent, new Map<string, FieldDefinition>());
    registerWithFields(
      NewChild,
      new Map<string, FieldDefinition>([
        ['parentId', new StubField('foreignKey', { related: 'NewParent' })],
      ]),
    );

    // db:migrate calls getInitializationOrder() over the WHOLE registered graph
    // before diffing. It must not throw on the pre-existing cycle.
    let order: string[] = [];
    expect(() => {
      order = ObjectRegistry.getInitializationOrder();
    }).not.toThrow();

    // Every registered class is present, and the acyclic dependency is ordered
    // correctly (dependency before dependant).
    expect(order).toContain('PreexistingCycleA');
    expect(order).toContain('PreexistingCycleB');
    expect(order).toContain('NewParent');
    expect(order).toContain('NewChild');
    expect(order.indexOf('NewParent')).toBeLessThan(order.indexOf('NewChild'));
  });
});
