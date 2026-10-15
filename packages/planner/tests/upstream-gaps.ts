/**
 * Recipe data gaps in the published smrt manifests (smrt 0.55.11, 0.56.0) that the
 * planner's recipe checks catch. Each needs a smrt release, so the checks name
 * the exact exception here instead of weakening the rule. An entry whose gap is
 * gone fails `tests/upstream-gaps.test.ts`: delete it when smrt fixes it.
 * https://github.com/happyvertical/smrt/issues/3769 and https://github.com/happyvertical/smrt/issues/4006
 */
export const UPSTREAM_GAPS = {
  /** A recipe that writes its menu label in title case (none since smrt 0.56). */
  titleCaseLabel: new Set<string>(),
  /** A nav id in two recipes' menus with two labels (none since smrt 0.56). */
  sharedNavId: new Set<string>(),
  /** `recipeId Model`: a model the recipe lists whose shown fields have no description (`@field({ description })`), so help has no glossary for them. */
  undescribedModel: new Set([
    // smrt 0.56 (smrt#4006)
    'reports.runtime RuntimeReport',
  ]),
  /**
   * `recipeId Model.field`: a shown field with no description while the rest of
   * its model has one: smrt 0.56's `LicenseSale` `Meta` fields, and the last
   * gaps of #3769 (smrt#4006).
   */
  undescribedField: new Set(
    [
      'skuId',
      'paymentId',
      'licenseeEmail',
      'licenseeLegalEntity',
      'licenseeJurisdiction',
      'rightsMedium',
      'rightsDistributionScope',
      'rightsExclusivity',
      'rightsDuration',
      'rightsTerritory',
      'rightsSublicensing',
      'rightsDerivatives',
      'pdfUrl',
      'pdfHash',
      'onChainHashRegistryRef',
    ]
      .map((f) => `commerce.licenses LicenseSale.${f}`)
      .concat([
        'messages.mailbox EmailAccount.credentialSecretId',
        'messages.mailbox EmailAccount.settings',
        'users.sign-in Session.parentSessionId',
      ]),
  ),
  /**
   * smrt 0.56's `reports.runtime` (smrt#4006): no `synonyms`, so fewer
   * than three match terms; the label `Reports`, which `reports.materialized`
   * also uses; no `section`, so its menu section has no icon or description;
   * a nav entry with no `description`; and help with no sections or tasks.
   */
  fewMatchTerms: new Set(['reports.runtime']),
  sharedRecipeLabel: new Set(['reports.runtime']),
  noSection: new Set(['reports.runtime']),
  undescribedNavEntry: new Set(['reports.runtime']),
  /** Help with fewer than two sections or tasks (`reports.runtime`: prose under one `#` title). */
  unstructuredHelp: new Set(['reports.runtime']),
  /** Help that names a field the recipe's models hide (none since smrt 0.56). */
  helpRefsHiddenField: new Set<string>(),
  /** Help prose that uses developer vocabulary (none since smrt 0.56). */
  developerVocabulary: new Set<string>(),
} as const;
