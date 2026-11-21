/**
 * The pure internal-model classifier shared by the scanner, the manifest
 * loader and the decorator path: `_smrt_` system tables, the two junction
 * base names, the junction constructor brand, and the monotonic merge of
 * kinds.
 */
import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../../collection';
import {
  isJunctionBaseName,
  isJunctionCollectionConstructor,
  isSystemTableName,
  mergeInternalKind,
  normalizeTableName,
} from '../internal-model';

describe('_smrt_ normalisation', () => {
  it.each([
    ['_smrt_jobs', '_smrt_jobs'],
    ['  _smrt_jobs  ', '_smrt_jobs'],
    ['"_smrt_jobs"', '_smrt_jobs'],
    ['_SMRT_Jobs', '_smrt_jobs'],
    ['public._smrt_jobs', '_smrt_jobs'],
    ['"public"."_Smrt_Jobs"', '_smrt_jobs'],
    ['`main`.`_smrt_jobs`', '_smrt_jobs'],
  ])('normalises %s to %s and classifies it as a system table', (raw, expected) => {
    expect(normalizeTableName(raw)).toBe(expected);
    expect(isSystemTableName(raw)).toBe(true);
  });

  it.each([
    'smrt_jobs',
    'jobs__smrt_',
    'my_smrt_jobs',
    'a.b._smrt_jobs',
    '',
    undefined,
  ])('does not classify %s as a system table', (raw) => {
    expect(isSystemTableName(raw)).toBe(false);
  });
});

describe('junction base names and brand', () => {
  it('matches both junction bases, simple or qualified, and nothing else', () => {
    expect(isJunctionBaseName('SmrtJunction')).toBe(true);
    expect(isJunctionBaseName('SmrtJunctionBase')).toBe(true);
    expect(isJunctionBaseName('@happyvertical/smrt-core:SmrtJunction')).toBe(
      true,
    );
    expect(isJunctionBaseName('SmrtCollection')).toBe(false);
    expect(isJunctionBaseName('MySmrtJunction')).toBe(false);
    expect(isJunctionBaseName(undefined)).toBe(false);
  });

  it('recognises the static brand on any constructor, not instanceof', () => {
    class OtherCopyJunctionBase extends SmrtCollection<never> {
      static readonly _isJunctionBase = true as const;
    }
    class Plain extends SmrtCollection<never> {}
    expect(isJunctionCollectionConstructor(OtherCopyJunctionBase)).toBe(true);
    expect(isJunctionCollectionConstructor(Plain)).toBe(false);
    expect(isJunctionCollectionConstructor(undefined)).toBe(false);
  });
});

describe('mergeInternalKind', () => {
  it('never clears a kind, and system wins over junction', () => {
    expect(mergeInternalKind('junction', undefined)).toBe('junction');
    expect(mergeInternalKind(undefined, 'junction')).toBe('junction');
    expect(mergeInternalKind('junction', 'system')).toBe('system');
    expect(mergeInternalKind('system', 'junction')).toBe('system');
    expect(mergeInternalKind(undefined, undefined)).toBeUndefined();
  });
});
