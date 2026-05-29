/**
 * Regression for the smrt#1311 consumer-migration finding: the registered
 * class must carry the manifest's pluralized `collection` (the endpoint
 * segment the SvelteKit generator routes under), distinct from the
 * snake_case `tableName`. Runtime consumers like `createResourceListHandler`
 * read `RegisteredClass.collection` to build URLs that match generated
 * routes; without it, multi-word resources 404.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('registerFromManifest stores collection (smrt#1311)', () => {
  let restore: () => void;
  afterEach(() => {
    restore?.();
  });

  it('stores the manifest collection verbatim, even when it diverges from tableName', () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerFromManifest(
      '@test/app:SourceCrawl',
      {
        className: 'SourceCrawl',
        collection: 'sourcecrawls', // endpoint segment (generator routes here)
        fields: {},
        methods: {},
        decoratorConfig: { tableName: 'source_crawls', api: true, cli: true },
        schema: { tableName: 'source_crawls', columns: {} },
      },
      '@test/app',
    );

    const registered = ObjectRegistry.getClass('SourceCrawl');
    expect(registered?.collection).toBe('sourcecrawls');
    // tableName (storage) stays snake_case and must NOT be used as the
    // endpoint segment.
    expect(registered?.schema?.tableName).toBe('source_crawls');
  });

  it('falls back to simple pluralization when the manifest omits collection', () => {
    restore = snapshotObjectRegistryState();
    // Legacy/partial manifest entry without a `collection` field.
    ObjectRegistry.registerFromManifest(
      '@test/app:CompanyResearch',
      {
        className: 'CompanyResearch',
        fields: {},
        methods: {},
        decoratorConfig: { api: true, cli: true },
      },
      '@test/app',
    );

    const registered = ObjectRegistry.getClass('CompanyResearch');
    // ch -> ches per the scanner's simple inflection.
    expect(registered?.collection).toBe('companyresearches');
  });
});
