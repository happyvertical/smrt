/**
 * Tests for the mcp-advisor get-object-config tool.
 *
 * Registry-backed: imported @smrt() fixtures supply runtime decorator config,
 * manifest-hydrated fields, and prototype custom methods. Asserts the assembled
 * ObjectConfig (decorator/api/mcp/cli/hooks, fields, customMethods) and the
 * yaml format branch.
 */

import { describe, expect, it } from 'vitest';
import {
  AdvisorBooleanWidget,
  AdvisorExcludeNote,
  AdvisorRichProduct,
} from '../../__tests__/fixtures/advisor-test-classes.js';
import { getObjectConfig } from './get-object-config.js';

void AdvisorBooleanWidget;
void AdvisorExcludeNote;
void AdvisorRichProduct;

describe('mcp-advisor: getObjectConfig', () => {
  it('assembles decorator config, fields and custom methods (object-form config)', async () => {
    const result = await getObjectConfig({ className: 'AdvisorRichProduct' });

    expect(result.className).toBe('AdvisorRichProduct');

    // Object-form api/mcp include lists round-trip through the registry config.
    expect(result.decorator.api).toMatchObject({
      include: ['list', 'get', 'create', 'update', 'archive'],
    });
    expect(result.decorator.mcp).toMatchObject({ include: ['list', 'get'] });
    expect(result.decorator.cli).toBe(true);
    expect(result.decorator.hooks).toMatchObject({
      beforeSave: 'validateAdvisor',
      afterSave: 'indexAdvisor',
    });

    // Fields come from the manifest.
    expect(result.fields).toHaveLength(3);
    expect(result.fields.map((f) => f.name).sort()).toEqual([
      'quantity',
      'rate',
      'title',
    ]);

    // The custom `recalculate` method is discovered from the prototype and the
    // standard CRUD/AI methods are filtered out.
    expect(result.customMethods).toContain('recalculate');
    expect(result.customMethods).not.toContain('save');
    expect(result.customMethods).not.toContain('is');
    expect(result.customMethods).not.toContain('do');
  });

  it('reports boolean api/mcp config and cli=false', async () => {
    const result = await getObjectConfig({ className: 'AdvisorBooleanWidget' });
    expect(result.decorator.api).toBe(true);
    expect(result.decorator.mcp).toBe(true);
    expect(result.decorator.cli).toBe(false);
    expect(result.decorator.hooks).toBeUndefined();
  });

  it('renders the yaml format branch without error', async () => {
    const result = await getObjectConfig({
      className: 'AdvisorRichProduct',
      format: 'yaml',
    });
    // The handler still returns the structured config regardless of format.
    expect(result.className).toBe('AdvisorRichProduct');
    expect(result.fields.length).toBeGreaterThan(0);
  });

  it('renders yaml for exclude-form config (covers exclude yaml branch)', async () => {
    const result = await getObjectConfig({
      className: 'AdvisorExcludeNote',
      format: 'yaml',
    });
    expect(result.decorator.api).toMatchObject({ exclude: ['delete'] });
    expect(result.decorator.mcp).toMatchObject({ exclude: ['delete'] });
  });

  it('returns an empty config for an unregistered class', async () => {
    // getConfig() returns {} (truthy) for unknown classes, so the handler
    // resolves with an empty decorator and zero fields rather than throwing.
    const result = await getObjectConfig({ className: 'TotallyUnknownClass' });
    expect(result.className).toBe('TotallyUnknownClass');
    expect(result.decorator).toEqual({});
    expect(result.fields).toEqual([]);
    expect(result.customMethods).toEqual([]);
  });
});
