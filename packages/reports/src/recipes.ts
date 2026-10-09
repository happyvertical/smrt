/**
 * Declared recipes for smrt-reports (#3719): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * `reports.materialized` brings the refresh bookkeeping tables a declared
 * (`@report`) report needs. The report classes themselves belong to the app, so
 * they are not listed here. It declares no surfaces: this package ships no
 * Svelte components, and the assistant reaches declared reports through the
 * `reports.query` tools in `@happyvertical/smrt-agents`.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import {
  SmrtPrincipalReportRefreshTask,
  SmrtReportRefreshTask,
} from './scheduler.js';
import {
  SmrtReportLock,
  SmrtReportRun,
  SmrtReportSchedule,
  SmrtReportWatermark,
} from './state.js';

/** Reports: totals and trends kept ready to read, refreshed on a schedule. */
export class MaterializedReportsRecipe extends SmrtRecipe {
  static id = 'reports.materialized';
  static help = './materialized.recipe.md';
  static label = 'Reports';
  static summary =
    'Keep totals and trends ready to read, refreshed on a schedule and open to the assistant.';
  static synonyms = [
    'reports',
    'totals',
    'summaries',
    'rollups',
    'kpis',
    'trends',
    'dashboards',
  ];
  // Refresh bookkeeping only. Every table is internal (`_smrt_` prefix, no REST
  // or MCP surface), so there is no `nav`; the app's own `@report` classes bring
  // their own rows and views.
  static models = [
    SmrtReportRun,
    SmrtReportWatermark,
    SmrtReportLock,
    SmrtReportSchedule,
    SmrtReportRefreshTask,
    SmrtPrincipalReportRefreshTask,
  ];
  // Aggregation runs as SQL against the app database, and scheduled refreshes
  // are queued through smrt-jobs; neither can run in a browser.
  static runtime = 'server' as const;
}
