/**
 * A consumer's report model and its `SmrtReportCollection`, registered the way
 * an app's manifest describes them (#3110): the model is scanned into the
 * app's manifest under the app's package, while its collection is attributed
 * to the library package that declares it. Before #3110 the collection was not
 * recognized as a collection (`SmrtReportCollection` is an unregistered
 * framework base), so the schema planner saw two unrelated classes claiming
 * the model's table and refused every schema build.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';

type ManifestDefinition = Parameters<
  typeof ObjectRegistry.registerFromManifest
>[1];

export const REPORT_TABLE = 'usage_daily_reports';

const reportFields: ManifestDefinition['fields'] = {
  day: { type: 'text' },
  unit: { type: 'text' },
  total: { type: 'integer' },
};

const reportSchema: ManifestDefinition['schema'] = {
  tableName: REPORT_TABLE,
  ddl: '',
  columns: {},
  indexes: [],
  version: 'test',
};

export function registerConsumerReportCollection(): void {
  ObjectRegistry.registerFromManifest(
    'UsageDailyReport',
    {
      name: 'usagedailyreport',
      className: 'UsageDailyReport',
      collection: 'usagedailyreports',
      filePath: 'packages/dashboard/src/models/UsageDailyReport.ts',
      extends: 'SmrtReport',
      fields: reportFields,
      methods: {},
      decoratorConfig: { tableName: REPORT_TABLE },
      schema: reportSchema,
    },
    '@fixture/dashboard',
  );
  ObjectRegistry.registerFromManifest(
    'UsageDailyReportCollection',
    {
      name: 'usagedailyreportcollection',
      className: 'UsageDailyReportCollection',
      collection: 'usagedailyreports',
      filePath: 'packages/core/src/collections/UsageDailyReportCollection.ts',
      extends: 'SmrtReportCollection',
      extendsTypeArg: 'UsageDailyReport',
      fields: reportFields,
      methods: {},
      decoratorConfig: { tableName: REPORT_TABLE },
      schema: reportSchema,
    },
    '@fixture/core',
  );
}

/** An unrelated class that names the report's table: still a conflict. */
export function registerUnrelatedTableClaimant(): void {
  ObjectRegistry.registerFromManifest(
    'UsageDailyArchive',
    {
      name: 'usagedailyarchive',
      className: 'UsageDailyArchive',
      collection: 'usagedailyarchives',
      filePath: 'packages/archive/src/UsageDailyArchive.ts',
      extends: 'SmrtObject',
      fields: { archivedAt: { type: 'datetime' } },
      methods: {},
      decoratorConfig: { tableName: REPORT_TABLE },
      schema: reportSchema,
    },
    '@fixture/archive',
  );
}
