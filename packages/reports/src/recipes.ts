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
import { RuntimeReport } from './runtime-report.js';
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
  // Not "Reports": that is reports.runtime, the one a person asks for ("a
  // summary of sales last month"). This one is refresh bookkeeping with no
  // menu entry, so it keeps the scheduling words.
  static label = 'Scheduled reports';
  static summary =
    'Keep totals and trends ready to read, refreshed on a schedule and open to the assistant.';
  static synonyms = ['rollups', 'kpis', 'refresh schedule', 'materialized'];
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

/** Tenant-shared reports proposed by the assistant and approved by a person. */
export class RuntimeReportsRecipe extends SmrtRecipe {
  static id = 'reports.runtime';
  static label = 'Reports';
  static synonyms = [
    'report',
    'summary',
    'summaries',
    'totals',
    'trends',
    'dashboards',
  ];
  static summary =
    'Ask for a report, approve it, and share its live totals with your team.';
  static help = './runtime.recipe.md';
  static models = [RuntimeReport];
  // Not "Reports": the recipe is its own section, and that is its name.
  static nav = [
    {
      label: 'Saved reports',
      model: RuntimeReport,
      icon: 'fileText',
      noun: 'report',
      description: 'Reports your team approved, kept up to date.',
    },
  ];
  static surfaces = [
    {
      // The Reports section page: the saved reports themselves, not a count.
      kind: 'widget',
      type: 'saved-reports',
      export: '@happyvertical/smrt-reports/svelte#SavedReportsWidget',
      label: 'Saved reports',
      description: 'Your team’s saved reports with their latest figures.',
      icon: 'fileText',
      options: [
        {
          key: 'limit',
          type: 'integer',
          label: 'Reports shown',
          min: 1,
          max: 24,
          default: 6,
        },
      ],
      sectionDefault: true,
      defaultSpan: 4,
      minSpan: 2,
      maxSpan: 4,
    },
    {
      kind: 'route',
      path: '/reports',
      export: '@happyvertical/smrt-reports/svelte#RuntimeReportsRoute',
      label: 'Reports',
    },
    {
      kind: 'route',
      path: '/reports/:id',
      export: '@happyvertical/smrt-reports/svelte#RuntimeReportDetailRoute',
      label: 'Report detail',
    },
    {
      kind: 'widget',
      type: 'runtime-report-chart',
      export: '@happyvertical/smrt-reports/svelte#RuntimeReportChartWidget',
      label: 'Report chart',
      description: 'Chart a measure from a saved report.',
      icon: 'chart',
      optionsEditor:
        '@happyvertical/smrt-reports/svelte#RuntimeReportWidgetOptions',
      options: [
        { key: 'reportId', type: 'text', label: 'Report', required: true },
        {
          key: 'measure',
          type: 'identifier',
          label: 'Measure',
          required: true,
        },
        { key: 'dimension', type: 'identifier', label: 'Dimension' },
      ],
      data: {
        load: '@happyvertical/smrt-reports#loadRuntimeReportChart',
        models: ['@happyvertical/smrt-reports:RuntimeReport'],
      },
      defaultSpan: 2,
      maxSpan: 4,
    },
  ] as const;
  static runtime = 'server' as const;
}
