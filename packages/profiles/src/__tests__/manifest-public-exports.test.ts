import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as profilesCollections from '../collections/index.js';
import * as profilesPublicApi from '../index.js';
import * as profilesModels from '../models/index.js';

interface ManifestObjectDefinition {
  collectionExportName?: string;
  exportName?: string;
  hasCollection?: boolean;
  name?: string;
  visibility?: string;
}

describe('profiles manifest public exports', () => {
  it('exports every symbol used by generated consumer registration', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../manifest/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as { objects: Record<string, ManifestObjectDefinition> };
    const registrationExports = new Set<string>();

    for (const [objectName, definition] of Object.entries(manifest.objects)) {
      if (definition.visibility === 'test') continue;

      registrationExports.add(
        definition.exportName ?? definition.name ?? objectName,
      );
      if (definition.hasCollection && definition.collectionExportName) {
        registrationExports.add(definition.collectionExportName);
      }
    }

    const missingExports = [...registrationExports]
      .filter((exportName) => !(exportName in profilesPublicApi))
      .sort();

    expect(missingExports).toEqual([]);
  });

  it('keeps the OIDC reservation exports in their domain barrels', () => {
    expect(profilesModels.OidcProfileEmailReservation).toBe(
      profilesPublicApi.OidcProfileEmailReservation,
    );
    expect(profilesCollections.OidcProfileEmailReservationCollection).toBe(
      profilesPublicApi.OidcProfileEmailReservationCollection,
    );
  });
});
