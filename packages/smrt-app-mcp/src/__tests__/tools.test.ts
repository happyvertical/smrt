/**
 * Tool-name policy unit tests.
 */

import { describe, expect, it } from 'vitest';
import {
  classNamePrefixes,
  isAllowedCoreTool,
  isPublicToolName,
  isReadOnlyToolName,
  matchesToolPattern,
} from '../tools.js';

describe('matchesToolPattern', () => {
  it('handles exact names', () => {
    expect(
      matchesToolPattern('companyresearch_list', 'companyresearch_list'),
    ).toBe(true);
    expect(
      matchesToolPattern('companyresearch_get', 'companyresearch_list'),
    ).toBe(false);
  });

  it('handles prefix and suffix wildcards', () => {
    expect(matchesToolPattern('companyresearch_get', 'companyresearch_*')).toBe(
      true,
    );
    expect(matchesToolPattern('preferencerule_get', '*_get')).toBe(true);
    expect(matchesToolPattern('opportunity_update', 'opportunity_*')).toBe(
      true,
    );
  });

  it('handles wildcards in the middle and at both ends', () => {
    expect(matchesToolPattern('user_account_list', 'user_*_list')).toBe(true);
    expect(matchesToolPattern('user_account_list', 'user_*')).toBe(true);
    expect(matchesToolPattern('account_list', 'user_*_list')).toBe(false);
  });

  it('treats the catch-all star as matching everything', () => {
    expect(matchesToolPattern('anything_at_all', '*')).toBe(true);
    expect(matchesToolPattern('', '*')).toBe(true);
  });

  it('rejects empty patterns explicitly so an empty env var matches nothing', () => {
    expect(matchesToolPattern('companyresearch_list', '')).toBe(false);
  });
});

describe('isReadOnlyToolName', () => {
  it('matches list and get verbs', () => {
    expect(isReadOnlyToolName('opportunity_list')).toBe(true);
    expect(isReadOnlyToolName('opportunity_get')).toBe(true);
  });

  it('rejects mutating verbs', () => {
    expect(isReadOnlyToolName('opportunity_create')).toBe(false);
    expect(isReadOnlyToolName('opportunity_update')).toBe(false);
    expect(isReadOnlyToolName('opportunity_delete')).toBe(false);
  });
});

describe('isPublicToolName', () => {
  it('requires both read-only AND a pattern match', () => {
    expect(
      isPublicToolName('companyresearch_list', ['companyresearch_list']),
    ).toBe(true);
    expect(
      isPublicToolName('companyresearch_update', ['companyresearch_*']),
    ).toBe(false);
  });

  it('defaults to nothing public when no patterns are configured', () => {
    expect(isPublicToolName('companyresearch_list', [])).toBe(false);
  });
});

describe('classNamePrefixes / isAllowedCoreTool', () => {
  it('lower-cases class names and appends an underscore', () => {
    const prefixes = classNamePrefixes(['CompanyResearch', 'Opportunity']);
    expect(prefixes.has('companyresearch_')).toBe(true);
    expect(prefixes.has('opportunity_')).toBe(true);
  });

  it('allows tools that start with a configured class prefix', () => {
    const prefixes = classNamePrefixes(['CompanyResearch', 'Opportunity']);
    expect(isAllowedCoreTool('companyresearch_list', prefixes)).toBe(true);
    expect(isAllowedCoreTool('opportunity_update', prefixes)).toBe(true);
    expect(isAllowedCoreTool('user_list', prefixes)).toBe(false);
  });
});
