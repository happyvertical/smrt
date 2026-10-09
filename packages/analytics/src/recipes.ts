/**
 * Declared recipes for smrt-analytics (#3719): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * `analytics.reports` covers properties and saved reports. Event tracking
 * (`AnalyticsEvent`) and data streams are separate concerns and are left out.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { AnalyticsProperty } from './models/AnalyticsProperty.js';
import { AnalyticsReport } from './models/AnalyticsReport.js';

/** Analytics reports: saved traffic reports and an AI read on the results. */
export class AnalyticsReportsRecipe extends SmrtRecipe {
  static id = 'analytics.reports';
  static help = './reports.recipe.md';
  static label = 'Analytics';
  static summary =
    'Save traffic reports for your websites and apps and get a plain-language read on the results.';
  static synonyms = [
    'analytics',
    'traffic',
    'pageviews',
    'visitors',
    'web stats',
    'google analytics',
    'plausible',
    'matomo',
  ];
  static section = {
    id: 'analytics',
    label: 'Analytics',
    icon: 'layers',
    description: 'How your websites and apps are doing.',
  };
  static models = [AnalyticsProperty, AnalyticsReport];
  // Stored reports and their AI summaries need the app database and a server
  // held AI key; the provider credentials live on the property row. Only the
  // view component below renders in the browser, from data the server hands it.
  static runtime = 'server' as const;
  // `AnalyticsSummary` renders an empty state without data. `PropertyInfo` and
  // `EventsTable` take required row props and would fail with none, so they are
  // not routes; a host places them inside its own pages.
  static surfaces = [
    {
      kind: 'route',
      path: '/analytics/summary',
      export: '@happyvertical/smrt-analytics/svelte#AnalyticsSummary',
      label: 'Traffic summary',
    },
  ] as const;
  // Icons are shell icon names (`SHELL_ICON_PATHS` in smrt-svelte), which have
  // no chart or globe glyph; the section and entries use the closest ones.
  static nav = [
    {
      label: 'Analytics properties',
      model: AnalyticsProperty,
      icon: 'home',
      description: 'The websites and apps you track, and who tracks them.',
    },
    {
      label: 'Analytics reports',
      model: AnalyticsReport,
      icon: 'fileText',
      description: 'Saved reports, how often they run and what they found.',
    },
  ];
  // Literal values (`as const` keeps `visibility` a literal type): the scanner
  // reads these statically. Internal naming and raw query JSON stay out of the
  // way; stored result rows are read through the report, not edited by hand.
  static options = {
    AnalyticsProperty: {
      fields: {
        name: { visibility: 'hidden' },
        industryCategory: { visibility: 'advanced' },
        serviceLevel: { visibility: 'advanced' },
        lastSyncAt: { locked: true },
      },
    },
    AnalyticsReport: {
      fields: {
        dimensionFilter: { visibility: 'advanced' },
        metricFilter: { visibility: 'advanced' },
        orderBy: { visibility: 'advanced' },
        maxResults: { visibility: 'advanced' },
        resultData: { visibility: 'hidden', locked: true },
        rowCount: { locked: true },
        lastRunAt: { locked: true },
        nextRunAt: { locked: true },
        lastError: { locked: true },
      },
    },
  } as const;
}
