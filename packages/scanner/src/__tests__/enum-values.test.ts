import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEnumValues } from '../enum-values.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { extractTypeAliases } from '../oxc-parser.js';
import { OxcScanner } from '../scanner.js';

/** #3598: enum / literal-union fields emit their allowed values. */
describe('resolveEnumValues', () => {
  it('flattens aliases nested inside a union (flattened-members blind spot)', () => {
    const aliases = { Base: "'a' | 'b'", Ext: "Base | 'c'" };
    expect(resolveEnumValues("Ext | 'd'", aliases)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('drops null/undefined and duplicates, keeps declaration order', () => {
    expect(resolveEnumValues("'z' | null | 'a' | 'z' | undefined")).toEqual([
      'z',
      'a',
    ]);
  });

  it('resolves number literals including negatives', () => {
    expect(resolveEnumValues('-1 | 0 | 1')).toEqual([-1, 0, 1]);
  });

  it('is undefined for open or non-literal members', () => {
    expect(resolveEnumValues("'a' | string")).toBeUndefined();
    expect(resolveEnumValues('Unknown')).toBeUndefined();
    expect(resolveEnumValues('string')).toBeUndefined();
    expect(resolveEnumValues(null)).toBeUndefined();
  });

  it('is bounded on circular aliases', () => {
    expect(resolveEnumValues('A', { A: 'B', B: 'A' })).toBeUndefined();
  });

  it('keeps a pipe inside a quoted value', () => {
    expect(resolveEnumValues("'a|b' | 'c'")).toEqual(['a|b', 'c']);
  });

  it('ignores prototype keys', () => {
    expect(resolveEnumValues('constructor', {})).toBeUndefined();
  });
});

describe('enum declarations -> aliases', () => {
  const aliasesOf = async (source: string) => {
    const { parseSource } = await import('../oxc-parser.js');
    return parseSource(source, '/x.ts').typeAliases;
  };

  it('uses values, not member names, for string enums', async () => {
    expect(
      await aliasesOf(
        "export enum S { Draft = 'draft', Active = 'active_now' }",
      ),
    ).toEqual({ S: "'draft' | 'active_now'" });
  });

  it('handles const enum, numeric, auto-increment and negative members', async () => {
    const a = await aliasesOf(
      'export const enum N { A = 5, B, C = -2, D }\nenum Auto { X, Y, Z }',
    );
    expect(a.N).toBe('5 | 6 | -2 | -1');
    expect(a.Auto).toBe('0 | 1 | 2');
  });

  it('supports substitution-free template initializers', async () => {
    expect((await aliasesOf('enum T { A = `a`, B = `b` }')).T).toBe(
      "'a' | 'b'",
    );
  });

  it('refuses mixed and computed enums rather than emitting a partial set', async () => {
    const a = await aliasesOf(
      "enum M { A = 'a', B = 1 }\nenum C { A = 'a', B = compute() }",
    );
    expect(a.M).toBeUndefined();
    expect(a.C).toBeUndefined();
  });

  it('exports extractTypeAliases for parsed bodies', () => {
    expect(typeof extractTypeAliases).toBe('function');
  });
});

describe('ManifestAdapter enum emission (end to end)', () => {
  let dir: string;
  const write = (rel: string, source: string) => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-enum-values-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function manifestFor() {
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    const { results, resolved } = await scanner.scanAndResolve();
    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: '@test/enum-values',
      typeAliases: results.typeAliases,
    });
    return Object.values(manifest.objects)[0].fields;
  }

  it('emits enum for every declaration form, including imported types', async () => {
    write(
      'src/types.ts',
      `export enum ContractStatus { Draft = 'draft', Active = 'active', Void = 'void' }
export const enum Tier { Low = 1, High = 3 }
export type Terms = 'net30' | 'net60';
export type TermsOrCustom = Terms | 'custom';
export type Currency = 'USD' | 'EUR';
export type Rank = 1 | 2 | 3;
`,
    );
    write(
      'src/Contract.ts',
      `import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { ContractStatus, Tier, Terms, TermsOrCustom, Currency, Rank } from './types';
@smrt()
export class Contract extends SmrtObject {
  status: ContractStatus = ContractStatus.Draft;
  maybeStatus: ContractStatus | null = null;
  tier: Tier = Tier.Low;
  terms: Terms = 'net30';
  flattened: TermsOrCustom = 'custom';
  currency: Currency | undefined;
  rank: Rank = 1;
  channel: 'web' | 'pos' = 'web';
  load: 1 | 2 | 3 = 1;
  free: string = '';
  openUnion: 'a' | string = 'a';
  count: number = 0;
}
`,
    );
    const fields = await manifestFor();
    expect(fields.status).toMatchObject({
      type: 'text',
      enum: ['draft', 'active', 'void'],
    });
    expect(fields.maybeStatus).toMatchObject({
      type: 'text',
      required: false,
      enum: ['draft', 'active', 'void'],
    });
    expect(fields.tier).toMatchObject({ type: 'integer', enum: [1, 3] });
    expect(fields.terms.enum).toEqual(['net30', 'net60']);
    expect(fields.flattened).toMatchObject({
      type: 'text',
      enum: ['net30', 'net60', 'custom'],
    });
    expect(fields.currency.enum).toEqual(['USD', 'EUR']);
    expect(fields.rank).toMatchObject({ type: 'integer', enum: [1, 2, 3] });
    expect(fields.channel.enum).toEqual(['web', 'pos']);
    expect(fields.load.enum).toEqual([1, 2, 3]);
    expect(fields.free.enum).toBeUndefined();
    expect(fields.openUnion.enum).toBeUndefined();
    expect(fields.count.enum).toBeUndefined();
  });
});
