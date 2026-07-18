import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as commissionsPublicApi from '../commissions/index.js';
import * as salesPublicApi from '../index.js';
import * as referralsPublicApi from '../referrals/index.js';

interface ManifestObjectDefinition {
  collectionExportName?: string;
  decoratorConfig?: {
    api?: boolean;
    cli?: boolean;
    mcp?: boolean;
  };
  exportName?: string;
  hasCollection?: boolean;
  name?: string;
  visibility?: string;
}

async function readSalesManifest(): Promise<{
  objects: Record<string, ManifestObjectDefinition>;
}> {
  return JSON.parse(
    await readFile(
      new URL('../../dist/manifest.json', import.meta.url),
      'utf8',
    ),
  );
}

describe('sales manifest runtime exports', () => {
  it('exports every symbol used by generated consumer registration', async () => {
    const manifest = await readSalesManifest();
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
      .filter((exportName) => !(exportName in salesPublicApi))
      .sort();

    expect(missingExports).toEqual([]);
  });

  it('keeps operation fences off generated application surfaces', async () => {
    const manifest = await readSalesManifest();

    for (const qualifiedName of [
      '@happyvertical/smrt-sales:CommissionAdjustmentOperation',
      '@happyvertical/smrt-sales:ReferralClickOperation',
    ]) {
      expect(manifest.objects[qualifiedName]?.decoratorConfig).toMatchObject({
        api: false,
        cli: false,
        mcp: false,
      });
    }
  });

  it('keeps private operation runtime symbols in their owning module barrels', () => {
    expect(commissionsPublicApi.CommissionAdjustmentOperation).toBe(
      salesPublicApi.CommissionAdjustmentOperation,
    );
    expect(commissionsPublicApi.CommissionAdjustmentOperationCollection).toBe(
      salesPublicApi.CommissionAdjustmentOperationCollection,
    );
    expect(referralsPublicApi.ReferralClickOperation).toBe(
      salesPublicApi.ReferralClickOperation,
    );
    expect(referralsPublicApi.ReferralClickOperationCollection).toBe(
      salesPublicApi.ReferralClickOperationCollection,
    );
  });
});
