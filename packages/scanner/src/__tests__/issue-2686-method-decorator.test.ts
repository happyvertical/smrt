/**
 * Scanner half of issue #2686.
 * https://github.com/happyvertical/smrt/issues/2686
 *
 * Two things have to reach the manifest for core's wire-ability gate to be
 * anything but a guess:
 *
 * 1. `@method()` config, read with the same literal-only rules the class-level
 *    `@smrt()` config uses — a dropped `expose: false` would silently restore
 *    the routing the author was withholding.
 * 2. Enough PROVENANCE about each parameter's declared type to tell "the author
 *    wrote `any`" from "the scanner could not express this", and to see the
 *    members an inline object literal hides behind the string `'object'`.
 */

import { describe, expect, it } from 'vitest';

import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';
import type {
  RawClassDefinition,
  RawMethodDefinition,
  ResolvedClassDefinition,
} from '../types.js';

function parseClass(body: string) {
  const source = `
    import { SmrtObject, smrt, method } from '@happyvertical/smrt-core';

    @smrt()
    class Widget extends SmrtObject {
      ${body}
    }
  `;
  const result = parseSource(source);
  return { result, widget: result.classes[0] };
}

/**
 * Minimal `ResolvedClassDefinition` for a class with no inheritance to merge —
 * `InheritanceResolver` is not under test here.
 */
function resolved(widget: RawClassDefinition): ResolvedClassDefinition {
  return {
    ...widget,
    inheritanceChain: ['SmrtObject'],
    resolvedConfig: widget.decoratorConfig ?? {},
    isSTI: false,
    isFrameworkBase: false,
    allFields: widget.fields,
    packageName: null,
  };
}

function methodNamed(
  methods: RawMethodDefinition[],
  name: string,
): RawMethodDefinition {
  const found = methods.find((m) => m.name === name);
  if (!found) throw new Error(`no method ${name}`);
  return found;
}

describe('#2686 @method() extraction', () => {
  it('reads the decorator config onto the method', () => {
    const { widget } = parseClass(`
      @method({ httpMethod: 'POST', path: 'reviews', effect: 'write' })
      async runReview(kind: string): Promise<void> {}
    `);
    expect(methodNamed(widget.methods, 'runReview').decoratorConfig).toEqual({
      httpMethod: 'POST',
      path: 'reviews',
      effect: 'write',
    });
  });

  it('records a bare @method() as {} — distinct from no decorator', () => {
    const { widget } = parseClass(`
      @method()
      async reviewed(): Promise<void> {}

      async plain(): Promise<void> {}
    `);
    expect(methodNamed(widget.methods, 'reviewed').decoratorConfig).toEqual({});
    expect(
      methodNamed(widget.methods, 'plain').decoratorConfig,
    ).toBeUndefined();
  });

  it('reads expose: false on a static method', () => {
    const { widget } = parseClass(`
      @method({ expose: false, reason: 'callback registration' })
      static registerValidator(validate: (value: unknown) => boolean): void {}
    `);
    const registered = methodNamed(widget.methods, 'registerValidator');
    expect(registered.isStatic).toBe(true);
    expect(registered.decoratorConfig).toEqual({
      expose: false,
      reason: 'callback registration',
    });
  });

  it('errors rather than dropping an unresolvable @method() config', () => {
    // A silently dropped `expose: false` restores the routing the author was
    // withholding — the same silent-widening failure #2100 closed for classes.
    const { result } = parseClass(`
      @method({ expose: HIDDEN })
      async runReview(): Promise<void> {}
    `);
    const errors = result.errors.filter((e) => e.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('@method()');
    expect(errors[0].message).toContain('HIDDEN');
  });

  it('still names @smrt() in a class-config diagnostic', () => {
    const source = `
      import { SmrtObject, smrt } from '@happyvertical/smrt-core';
      @smrt({ ...IMPORTED })
      class Widget extends SmrtObject {}
    `;
    const errors = parseSource(source).errors.filter(
      (e) => e.severity === 'error',
    );
    expect(errors[0].message).toContain('@smrt()');
  });

  it('carries the config through to the manifest', () => {
    const { widget } = parseClass(`
      @method({ expose: false, reason: 'internal' })
      async sweep(): Promise<void> {}
    `);
    const manifest = new ManifestAdapter().toManifest([resolved(widget)]);
    const object = Object.values(manifest.objects)[0];
    expect(object.methods.sweep.decoratorConfig).toEqual({
      expose: false,
      reason: 'internal',
    });
  });
});

describe('#2686 parameter type provenance', () => {
  it('marks an unsupported type annotation as unresolved', () => {
    const { widget } = parseClass(`
      async search(filters: SearchFilters & { limit: number }): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'search').parameters;
    expect(parameter.type).toBeNull();
    expect(parameter.typeUnresolved).toBe(true);
  });

  it('does NOT mark an explicit any as unresolved', () => {
    const { widget } = parseClass(`
      async run(payload: any): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBe('any');
    expect(parameter.typeUnresolved).toBeUndefined();
  });

  it('does NOT mark a missing annotation as unresolved', () => {
    const { widget } = parseClass(`
      async run(payload): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBeNull();
    expect(parameter.typeUnresolved).toBeUndefined();
  });

  it('resolves unknown and the bare object keyword', () => {
    const { widget } = parseClass(`
      async run(a: unknown, b: object): Promise<void> {}
    `);
    const parameters = methodNamed(widget.methods, 'run').parameters;
    expect(parameters[0]).toMatchObject({ type: 'unknown' });
    expect(parameters[0].typeUnresolved).toBeUndefined();
    expect(parameters[1]).toMatchObject({ type: 'object' });
    expect(parameters[1].typeUnresolved).toBeUndefined();
  });

  it('exposes the members of an inline object literal', () => {
    const { widget } = parseClass(`
      async run(options: { limit: number; onProgress: () => void }): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBe('object');
    expect(parameter.memberTypes).toEqual(
      expect.arrayContaining(['number', 'Function']),
    );
  });

  it('treats an inline method signature as a callable member', () => {
    const { widget } = parseClass(`
      async run(options: { onProgress(done: number): void }): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.memberTypes).toContain('Function');
  });

  it('reaches a model instance nested inside an inline literal', () => {
    const { widget } = parseClass(`
      async record(options: { actor: Profile | null; note: string }): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'record').parameters;
    expect(parameter.memberTypes).toEqual(
      expect.arrayContaining(['Profile | null', 'string']),
    );
  });

  it('leaves a NAMED bag unexpanded', () => {
    // Deliberate: resolving an interface needs cross-file type resolution this
    // AST layer does not do, so named bags are accepted heuristically instead.
    const { widget } = parseClass(`
      async runReview(options: RunContentReviewOptions): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'runReview').parameters;
    expect(parameter.type).toBe('RunContentReviewOptions');
    expect(parameter.memberTypes).toBeUndefined();
  });

  it('marks a generic with an unresolvable type argument as unresolved', () => {
    // Dropping the bad argument left the bare string `'Array'`, which carries
    // no provenance and is default-accepted by core's wire-ability gate.
    const { widget } = parseClass(`
      async run(rows: Array<[string, Asset]>): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBeNull();
    expect(parameter.typeUnresolved).toBe(true);
  });

  it('marks a union with an unresolvable branch as unresolved', () => {
    const { widget } = parseClass(`
      async run(value: (A & B) | (C & D)): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBeNull();
    expect(parameter.typeUnresolved).toBe(true);
  });

  it('resolves a `this` parameter so its union stays expressible', () => {
    const { widget } = parseClass(`
      async moveTo(newParent: this | string | null): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'moveTo').parameters;
    expect(parameter.type).toBe('this | string | null');
    expect(parameter.typeUnresolved).toBeUndefined();
  });

  it('still resolves a generic whose arguments are all expressible', () => {
    const { widget } = parseClass(`
      async run(byId: Record<string, Asset | null>): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBe('Record<string, Asset | null>');
    expect(parameter.typeUnresolved).toBeUndefined();
  });

  it('marks an inline literal with an unresolvable member as unresolved', () => {
    const { widget } = parseClass(`
      async run(options: { filter: A & B }): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBe('object');
    expect(parameter.typeUnresolved).toBe(true);
  });

  it('keeps a qualified class reference resolvable by its full name', () => {
    const { widget } = parseClass(`
      async run(asset: assets.Asset): Promise<void> {}
    `);
    const [parameter] = methodNamed(widget.methods, 'run').parameters;
    expect(parameter.type).toBe('assets.Asset');
  });

  it('carries the provenance through to the manifest', () => {
    const { widget } = parseClass(`
      async run(a: A & B, b: { onDone: () => void }): Promise<void> {}
    `);
    const manifest = new ManifestAdapter().toManifest([resolved(widget)]);
    const parameters = Object.values(manifest.objects)[0].methods.run
      .parameters;
    expect(parameters[0]).toMatchObject({ type: 'any', typeUnresolved: true });
    expect(parameters[1]).toMatchObject({ type: 'object' });
    expect(parameters[1].memberTypes).toContain('Function');
  });

  it('omits both provenance keys for an ordinary parameter', () => {
    // Keeps the emitted manifest byte-identical for the overwhelming majority
    // of parameters.
    const { widget } = parseClass(`
      async run(id: string): Promise<void> {}
    `);
    const manifest = new ManifestAdapter().toManifest([resolved(widget)]);
    const [parameter] = Object.values(manifest.objects)[0].methods.run
      .parameters;
    expect(Object.keys(parameter).sort()).toEqual([
      'default',
      'name',
      'optional',
      'type',
    ]);
  });
});
