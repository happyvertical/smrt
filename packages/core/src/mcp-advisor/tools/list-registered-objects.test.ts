/**
 * Tests for the mcp-advisor list-registered-objects tool.
 *
 * Registry-backed: importing the fixture modules registers real @smrt() classes
 * (with fields from the test manifest) into the global ObjectRegistry. We do NOT
 * clear the registry here — clearing would drop the manifest-hydrated field
 * metadata. Instead we assert on the specific fixtures we registered.
 */

import { describe, expect, it } from 'vitest';
// Importing the fixtures triggers @smrt() registration as a side effect.
import {
  AdvisorBooleanWidget,
  AdvisorExcludeNote,
  AdvisorRichProduct,
} from '../../__tests__/fixtures/advisor-test-classes.js';
import { listRegisteredObjects } from './list-registered-objects.js';

// Reference the imported classes so tree-shaking / lint keeps the import.
void AdvisorBooleanWidget;
void AdvisorExcludeNote;
void AdvisorRichProduct;

describe('mcp-advisor: listRegisteredObjects', () => {
  it('lists registered objects with metadata derived from the registry', async () => {
    const result = await listRegisteredObjects({ filter: 'all' });

    expect(result.total).toBe(result.objects.length);
    expect(result.total).toBeGreaterThan(0);

    const rich = result.objects.find((o) => o.name === 'AdvisorRichProduct');
    expect(rich).toBeDefined();
    expect(rich?.type).toBe('object');
    expect(rich?.hasDecorator).toBe(true);
    expect(rich?.fieldCount).toBe(3);
    expect(rich?.apiEnabled).toBe(true);
    expect(rich?.mcpEnabled).toBe(true);
    expect(rich?.cliEnabled).toBe(true);
  });

  it('detects boolean api/mcp config and disabled cli', async () => {
    const result = await listRegisteredObjects();

    const widget = result.objects.find(
      (o) => o.name === 'AdvisorBooleanWidget',
    );
    expect(widget).toBeDefined();
    expect(widget?.apiEnabled).toBe(true);
    expect(widget?.mcpEnabled).toBe(true);
    expect(widget?.cliEnabled).toBe(false);
    expect(widget?.fieldCount).toBe(1);
  });

  it('treats exclude-only config as enabled (exclude !== undefined)', async () => {
    const result = await listRegisteredObjects();

    const note = result.objects.find((o) => o.name === 'AdvisorExcludeNote');
    expect(note).toBeDefined();
    expect(note?.apiEnabled).toBe(true);
    expect(note?.mcpEnabled).toBe(true);
    // No cli configured → disabled
    expect(note?.cliEnabled).toBe(false);
  });

  it('defaults filter to "all" when called with no arguments', async () => {
    const result = await listRegisteredObjects();
    expect(result.objects.length).toBe(result.total);
    expect(result.objects.some((o) => o.name === 'AdvisorRichProduct')).toBe(
      true,
    );
  });

  it('filters to objects only', async () => {
    const result = await listRegisteredObjects({ filter: 'objects' });
    expect(result.objects.every((o) => o.type === 'object')).toBe(true);
    expect(result.objects.some((o) => o.name === 'AdvisorRichProduct')).toBe(
      true,
    );
  });

  it('filters to collections only', async () => {
    const result = await listRegisteredObjects({ filter: 'collections' });
    // Every returned entry must be a collection; our object fixtures excluded.
    expect(result.objects.every((o) => o.type === 'collection')).toBe(true);
    expect(result.objects.some((o) => o.name === 'AdvisorRichProduct')).toBe(
      false,
    );
  });
});
