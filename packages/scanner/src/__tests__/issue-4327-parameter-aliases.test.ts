/**
 * #4327: method parameters typed with a same-module alias carry the alias
 * target as `resolvedType` (the authored name stays in `type`), resolved only
 * against the declaring module's own aliases.
 */
import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource, resolveParameterAlias } from '../oxc-parser.js';

function parametersOf(source: string, method: string) {
  const result = parseSource(source);
  expect(result.errors.filter((e) => e.severity === 'error')).toEqual([]);
  const found = result.classes[0]?.methods.find((m) => m.name === method);
  expect(found).toBeDefined();
  return found?.parameters ?? [];
}

const SOURCE = `
  import { SmrtObject, smrt } from '@happyvertical/smrt-core';
  import type { Imported } from './elsewhere';

  type ActionOptions = Record<string, unknown>;
  type Chained = ActionOptions;
  type Label = string;
  enum Mode { Fast = 'fast', Slow = 'slow' }
  type CycleA = CycleB;
  type CycleB = CycleA;

  @smrt()
  class Portfolio extends SmrtObject {
    static async create(options: ActionOptions) { return options; }
    async tag(payload: Chained, label: Label, mode: Mode) { return label; }
    async loop(value: CycleA) { return value; }
    async other(value: Imported, plain: string, list: Label[]) { return value; }
  }
`;

describe('#4327 same-module parameter alias resolution', () => {
  it('records the alias target and keeps the authored name', () => {
    const [options] = parametersOf(SOURCE, 'create');
    expect(options).toMatchObject({
      type: 'ActionOptions',
      resolvedType: 'Record<string, unknown>',
    });
  });

  it('follows chained, primitive, and enum aliases', () => {
    const [payload, label, mode] = parametersOf(SOURCE, 'tag');
    expect(payload.resolvedType).toBe('Record<string, unknown>');
    expect(label.resolvedType).toBe('string');
    expect(mode.resolvedType).toBe("'fast' | 'slow'");
  });

  it('marks a cyclic alias unresolved instead of guessing', () => {
    const [value] = parametersOf(SOURCE, 'loop');
    expect(value.resolvedType).toBeUndefined();
    expect(value.aliasUnresolved).toBe(true);
  });

  it('leaves imported, primitive, and non-bare types untouched', () => {
    for (const parameter of parametersOf(SOURCE, 'other')) {
      expect(parameter.resolvedType).toBeUndefined();
      expect(parameter.aliasUnresolved).toBeUndefined();
    }
  });

  it('carries both keys into the manifest only when set', () => {
    const adapter = new ManifestAdapter();
    const manifestMethods = Object.fromEntries(
      parseSource(SOURCE).classes[0].methods.map((method) => [
        method.name,
        adapter.convertMethod(method),
      ]),
    );
    expect(manifestMethods?.create.parameters[0]).toMatchObject({
      type: 'ActionOptions',
      resolvedType: 'Record<string, unknown>',
    });
    expect(manifestMethods?.loop.parameters[0].aliasUnresolved).toBe(true);
    expect(manifestMethods?.other.parameters[1]).not.toHaveProperty(
      'resolvedType',
    );
    expect(manifestMethods?.other.parameters[1]).not.toHaveProperty(
      'aliasUnresolved',
    );
  });

  it('resolves only own keys of the alias map', () => {
    expect(resolveParameterAlias('toString', {})).toBeUndefined();
    expect(resolveParameterAlias('constructor', {})).toBeUndefined();
    expect(resolveParameterAlias(null, { A: 'string' })).toBeUndefined();
  });
});
