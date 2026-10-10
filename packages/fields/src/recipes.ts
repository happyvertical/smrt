/**
 * Declared recipes for smrt-fields (#3719): small, user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { FieldPolicy } from './models/FieldPolicy.js';
import { FieldPolicySuggestion } from './models/FieldPolicySuggestion.js';
import { FieldUsageCounter } from './models/FieldUsageCounter.js';
import { FieldUsageReportReceipt } from './models/FieldUsageReportReceipt.js';

/**
 * Form customization: let an organization (and each person) change what the
 * forms ask for. Defaults, labels, hints, order and basic/advanced/hidden
 * visibility are stored as sparse override rows over the code seed.
 *
 * There is no `nav` on purpose: the policy tables have no generated read
 * surface (reads would enumerate every tenant), so the one place people
 * manage this is the `settings-panel` surface below.
 */
export class FormCustomizationRecipe extends SmrtRecipe {
  static id = 'fields.form-customization';
  static help = './form-customization.recipe.md';
  static label = 'Form customization';
  static summary =
    'Choose what your forms ask for: defaults, labels, hints and which fields are shown.';
  static synonyms = [
    'form defaults',
    'field defaults',
    'customize forms',
    'hide fields',
    'field visibility',
    'field labels',
  ];
  static models = [
    FieldPolicy,
    FieldPolicySuggestion,
    FieldUsageCounter,
    FieldUsageReportReceipt,
  ];
  // The policy rows, their stored resolver and the tenant-hierarchy walk reach
  // Node-only helpers from the package root entry until #3618 lands, so the
  // recipe is server-side today. The `/svelte` components themselves are
  // browser-safe: they render a policy resolved on the server.
  static runtime = 'server' as const;
  static surfaces = [
    {
      kind: 'settings-panel',
      export: '@happyvertical/smrt-fields/svelte#FieldPolicyControlPanel',
      label: 'Form defaults',
    },
  ] as const;
}
