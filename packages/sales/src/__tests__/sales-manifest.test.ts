import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface ManifestObject {
  decoratorConfig?: {
    api?: { writable?: string[] };
    mcp?: boolean | { include?: string[] };
  };
}

interface SalesManifest {
  objects: Record<string, ManifestObject>;
}

async function salesManifest(): Promise<SalesManifest> {
  const raw = await readFile(
    new URL('../../dist/manifest.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(raw) as SalesManifest;
}

function objectByName(manifest: SalesManifest, name: string): ManifestObject {
  const entry = Object.entries(manifest.objects).find(([key]) =>
    key.endsWith(`:${name}`),
  );
  if (!entry) {
    throw new Error(`Manifest object '${name}' not found`);
  }
  return entry[1];
}

describe('generated sales manifest mutation policy', () => {
  it.each([
    'SalesActivity',
    'LeadMerge',
  ])('keeps %s MCP operations append-only', async (objectName) => {
    const object = objectByName(await salesManifest(), objectName);
    expect(object.decoratorConfig?.mcp).toEqual({
      include: ['list', 'get', 'create'],
    });
  });

  it('does not allow generated Lead writes to replace acquisition history', async () => {
    const lead = objectByName(await salesManifest(), 'Lead');
    const writable = lead.decoratorConfig?.api?.writable;
    expect(writable).toBeDefined();
    expect(writable).not.toContain('acquisitionHistory');
  });
});
