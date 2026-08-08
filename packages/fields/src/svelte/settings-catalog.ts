/** Browser-safe view helpers for the field-policy settings catalog. */

import type {
  FieldPolicyDetailItem,
  FieldPolicySettingsCatalogData,
  FieldPolicySettingsCatalogPage,
  FieldPolicySummaryItem,
} from '../settings-catalog.js';
import type {
  FieldPolicyAuditSnapshot,
  FieldPolicyDriftRow,
  FieldPolicyLayerContribution,
  FieldPolicyVisibility,
  ResolvedFieldPolicy,
} from '../types.js';
import type { FieldPolicyEditorAdapter } from './field-policy-editor.js';

export const MAX_FIELD_POLICY_AUDIT_OBJECT_REFS = 100;

export interface FieldPolicyControlPanelAdapter
  extends FieldPolicyEditorAdapter {
  loadAudit(input?: {
    objectRefs?: string[];
    countObjectRefs?: string[];
    includeDrift?: boolean;
  }): Promise<FieldPolicyAuditSnapshot>;
}

/** Keeps every catalog navigation path on the caller-selected page size. */
export function fieldPolicyCatalogPreservedParams(
  data: Pick<FieldPolicySettingsCatalogData, 'page' | 'filters'>,
): Record<string, string> {
  return {
    ...(data.filters.packageFilter
      ? { package: data.filters.packageFilter }
      : {}),
    ...(data.filters.objectFilter ? { object: data.filters.objectFilter } : {}),
    ...(data.filters.customizedOnly ? { customized: '1' } : {}),
    pageSize: String(data.page.pageSize),
  };
}

export interface FieldPolicyLayerCell {
  contributed: boolean;
  defaultValue: unknown;
  hasDefault: boolean;
  locked: boolean;
  visibility: FieldPolicyVisibility;
  visibilityForced: boolean;
}

export interface FieldPolicyFieldRollup {
  known: boolean;
  code: FieldPolicyLayerCell;
  app: FieldPolicyLayerCell;
  org: FieldPolicyLayerCell;
  userCount: number;
  orgRow?: FieldPolicyAuditSnapshot['orgRows'][number];
  appRow?: FieldPolicyAuditSnapshot['appRows'][number];
  resolved?: ResolvedFieldPolicy;
}

export function auditObjectRefs(
  page: Pick<FieldPolicySettingsCatalogPage, 'items' | 'selected'>,
): { objectRefs: string[]; countObjectRefs: string[] } {
  const countObjectRefs = [
    ...new Set([
      ...(page.selected ? [page.selected.objectRef] : []),
      ...page.items.map((item) => item.objectRef),
    ]),
  ];
  return {
    objectRefs: countObjectRefs.slice(0, MAX_FIELD_POLICY_AUDIT_OBJECT_REFS),
    countObjectRefs,
  };
}

export function fieldPolicyRollup(
  audit: FieldPolicyAuditSnapshot,
  objectRef: string,
  fieldName: string,
): FieldPolicyFieldRollup {
  const policy = audit.policies[objectRef];
  const resolved = policy?.fields[fieldName];
  const layers = policy?.layers[fieldName] ?? [];
  const cell = (
    tiers: readonly FieldPolicyLayerContribution['layer'][],
    own: FieldPolicyLayerContribution['layer'],
  ): FieldPolicyLayerCell => {
    let defaultValue: unknown;
    let hasDefault = false;
    let visibility: FieldPolicyVisibility = 'basic';
    let locked = false;
    const accepted = layers.filter((layer) => tiers.includes(layer.layer));
    for (const layer of accepted) {
      if (layer.delta.default) {
        hasDefault = true;
        defaultValue = layer.delta.default.value;
      }
      if (layer.delta.visibility) visibility = layer.delta.visibility;
      if (layer.delta.locked !== undefined) locked = layer.delta.locked;
    }
    const visibilityForced =
      resolved?.visibilityForced === true && visibility !== 'basic';
    return {
      contributed: accepted.some((layer) => layer.layer === own),
      defaultValue,
      hasDefault,
      visibility: visibilityForced ? 'basic' : visibility,
      locked,
      visibilityForced,
    };
  };
  return {
    known: resolved !== undefined,
    code: cell(['code'], 'code'),
    app: cell(['code', 'app'], 'app'),
    org: cell(['code', 'app', 'tenant'], 'tenant'),
    userCount: audit.userOverrideCounts[objectRef]?.[fieldName] ?? 0,
    orgRow: audit.orgRows.find(
      (row) => row.objectRef === objectRef && row.fieldName === fieldName,
    ),
    appRow: audit.appRows.find(
      (row) => row.objectRef === objectRef && row.fieldName === fieldName,
    ),
    ...(resolved ? { resolved } : {}),
  };
}

export function decorateCatalogPage(
  page: FieldPolicySettingsCatalogPage,
  audit: FieldPolicyAuditSnapshot,
): FieldPolicySettingsCatalogPage {
  return {
    ...page,
    items: page.items.map((item) => decorateCatalogItem(item, audit)),
    selected: page.selected ? decorateCatalogItem(page.selected, audit) : null,
  };
}

export function decorateCatalogItem<T extends FieldPolicySummaryItem>(
  item: T,
  audit: FieldPolicyAuditSnapshot,
): Omit<T, 'label' | 'description' | 'status'> & FieldPolicySummaryItem {
  const rollup = fieldPolicyRollup(audit, item.objectRef, item.fieldName);
  const status = [
    rollup.app.contributed || rollup.appRow ? 'App' : null,
    rollup.org.contributed || rollup.orgRow ? 'Organization' : null,
    rollup.userCount
      ? `${rollup.userCount} user override${rollup.userCount === 1 ? '' : 's'}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    ...item,
    label: rollup.resolved?.label ?? humanize(item.fieldName),
    description: rollup.resolved?.help ?? item.description,
    ...(status ? { status } : {}),
  };
}

export function orgRowIdsForObject(
  audit: FieldPolicyAuditSnapshot,
  objectRef: string,
): string[] {
  return audit.orgRows
    .filter((row) => row.objectRef === objectRef)
    .map((row) => row.id);
}

export function prunableDriftRows(
  audit: FieldPolicyAuditSnapshot,
): FieldPolicyDriftRow[] {
  return audit.driftRows.filter((row) => row.prunable);
}

/** Structural tenant-nav seam; hosts supply it to AdminShell's tenant edge. */
export function fieldPolicyControlPanelNavItem(options: {
  href: string;
  permissions?: readonly string[];
  label?: string;
  icon?: string;
}): { href: string; label: string; icon?: string } | null {
  if (
    options.permissions &&
    !options.permissions.includes('fields.policy.manage')
  )
    return null;
  return {
    href: options.href,
    label: options.label ?? 'Field settings',
    ...(options.icon ? { icon: options.icon } : {}),
  };
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

export type { FieldPolicyDetailItem };
