/**
 * Tests for the mcp-advisor configure-decorators tool.
 *
 * Pure generator: assembles a `@smrt({...})` decorator string from the supplied
 * api/mcp/cli/hooks config. Covers each config branch plus the empty-config
 * fallback to a bare `@smrt()`.
 */

import { describe, expect, it } from 'vitest';
import { configureDecorators } from './configure-decorators.js';

describe('mcp-advisor: configureDecorators', () => {
  it('renders api include/exclude lists', async () => {
    const result = await configureDecorators({
      className: 'Product',
      api: { include: ['list', 'get'], exclude: ['delete'] },
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    const code = result.data as string;
    expect(code).toContain('@smrt({');
    expect(code).toContain('api: {');
    expect(code).toContain("include: ['list', 'get']");
    expect(code).toContain("exclude: ['delete']");
    expect(code).toContain('export class Product extends SmrtObject {');
  });

  it('renders mcp include/exclude lists', async () => {
    const result = await configureDecorators({
      className: 'Product',
      mcp: { include: ['list'], exclude: ['create'] },
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('mcp: {');
    expect(code).toContain("include: ['list']");
    expect(code).toContain("exclude: ['create']");
  });

  it('renders cli boolean (including false)', async () => {
    const enabled = await configureDecorators({ className: 'A', cli: true });
    expect(enabled.data as string).toContain('cli: true');

    const disabled = await configureDecorators({ className: 'A', cli: false });
    expect(disabled.data as string).toContain('cli: false');
  });

  it('renders lifecycle hooks', async () => {
    const result = await configureDecorators({
      className: 'Product',
      hooks: { beforeSave: 'validate', afterSave: 'index' },
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('hooks: {');
    expect(code).toContain("beforeSave: 'validate'");
    expect(code).toContain("afterSave: 'index'");
  });

  it('combines all config sections', async () => {
    const result = await configureDecorators({
      className: 'Combined',
      api: { include: ['list'] },
      mcp: { exclude: ['delete'] },
      cli: true,
      hooks: { beforeDelete: 'guard' },
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('api: {');
    expect(code).toContain('mcp: {');
    expect(code).toContain('cli: true');
    expect(code).toContain('hooks: {');
  });

  it('falls back to a bare @smrt() when no config is supplied', async () => {
    const result = await configureDecorators({ className: 'Bare' });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('@smrt()');
    expect(code).not.toContain('@smrt({');
  });

  it('ignores empty include/exclude arrays', async () => {
    const result = await configureDecorators({
      className: 'EmptyArrays',
      api: { include: [], exclude: [] },
      mcp: { include: [], exclude: [] },
      hooks: {},
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    // All sections empty → bare decorator
    expect(code).toContain('@smrt()');
    expect(code).not.toContain('@smrt({');
  });
});
