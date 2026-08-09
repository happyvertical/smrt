/**
 * Server-side data builder for the field-policy AdminShell destination.
 *
 * This deliberately mirrors the `@happyvertical/smrt-svelte/settings`
 * contract structurally. Fields does not depend on smrt-svelte, and only the
 * selected object carries its browser-safe field definitions.
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  FieldPolicyCollection,
  MAX_FIELD_POLICY_AUDIT_OBJECT_REFS,
} from './collections/FieldPolicyCollection.js';
import {
  getFieldReadPermission,
  getObjectFieldMap,
  isPolicyAddressableField,
  isSensitiveField,
  isTransientField,
} from './field-definitions.js';
import type { FieldPolicyAuditSnapshot } from './types.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const FORM_TYPES = new Set([
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'json',
  'foreignKey',
  'crossPackageRef',
]);
const SYSTEM_NAMES = new Set([
  'id',
  'slug',
  'context',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'deletedAt',
  'deleted_at',
  'tenantId',
  'tenant_id',
]);

export interface FieldPolicyCatalogField {
  type:
    | 'text'
    | 'integer'
    | 'decimal'
    | 'boolean'
    | 'datetime'
    | 'json'
    | 'foreignKey'
    | 'crossPackageRef';
  required?: boolean;
  default?: unknown;
  description?: string;
  ui?: { basic?: boolean; group?: string; order?: number; locked?: boolean };
}

export interface FieldPolicySummaryItem {
  id: string;
  label: string;
  description?: string;
  eyebrow?: string;
  status?: string;
  objectRef: string;
  fieldName: string;
  className: string;
  packageName: string;
}

export interface FieldPolicyDetailItem extends FieldPolicySummaryItem {
  fields: Record<string, FieldPolicyCatalogField>;
}

/** Structural SettingsCatalogPage mirror; `SettingsCatalog` accepts it directly. */
export interface FieldPolicySettingsCatalogPage {
  items: FieldPolicySummaryItem[];
  selected: FieldPolicyDetailItem | null;
  query: string;
  page: number;
  pageSize: number;
  total: number;
}

export interface FieldPolicyCatalogObjectSummary {
  objectRef: string;
  className: string;
  packageName: string;
  fieldCount: number;
}

export interface FieldPolicySettingsCatalogData {
  page: FieldPolicySettingsCatalogPage;
  audit: FieldPolicyAuditSnapshot;
  objects: FieldPolicyCatalogObjectSummary[];
  packages: string[];
  filters: {
    packageFilter: string | null;
    objectFilter: string | null;
    customizedOnly: boolean;
  };
}

export interface FieldPolicySettingsCatalogQuery {
  query?: string | null;
  page?: number | null;
  pageSize?: number | null;
  selectedId?: string | null;
  packageFilter?: string | null;
  objectFilter?: string | null;
  customizedOnly?: boolean;
}

export interface BuildFieldPolicySettingsCatalogOptions
  extends FieldPolicySettingsCatalogQuery {
  db?: SmrtClassOptions['db'];
  collection?: FieldPolicyCollection;
  objectRefs?: string[];
}

interface CatalogObject {
  objectRef: string;
  className: string;
  packageName: string;
  fields: Record<string, FieldPolicyCatalogField>;
}

export function fieldPolicyCatalogItemId(
  objectRef: string,
  fieldName: string,
): string {
  return `${objectRef}::${fieldName}`;
}

export function parseFieldPolicyCatalogQuery(
  params: URLSearchParams,
): FieldPolicySettingsCatalogQuery {
  return {
    query: params.get('q'),
    page: integerParam(params.get('page')),
    pageSize: integerParam(params.get('pageSize')),
    selectedId: params.get('selected'),
    packageFilter: params.get('package'),
    objectFilter: params.get('object'),
    customizedOnly: params.get('customized') === '1',
  };
}

export async function buildFieldPolicySettingsCatalog(
  options: BuildFieldPolicySettingsCatalogOptions,
): Promise<FieldPolicySettingsCatalogData> {
  const collection =
    options.collection ??
    (options.db
      ? await FieldPolicyCollection.create({ db: options.db })
      : null);
  if (!collection) throw new Error('A db or FieldPolicyCollection is required');

  const filters = {
    packageFilter: stringFilter(options.packageFilter),
    objectFilter: stringFilter(options.objectFilter),
    customizedOnly: options.customizedOnly === true,
  };
  const query = options.query?.trim() ?? '';
  const pageSize = clamp(options.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  // Authorization is established before registry enumeration, but this must
  // stay a capability-only call: no policy rows are read until the URL-driven
  // page (or the explicit customized filter) identifies its object refs.
  const baseAudit = await collection.policyAudit({ summaryOnly: true });
  if (!baseAudit.caller.canManageOrg) {
    return {
      page: emptyPage(query, pageSize),
      audit: baseAudit,
      objects: [],
      packages: [],
      filters,
    };
  }

  const objects = await listCatalogObjects(options.objectRefs);
  const candidates = objects.filter(
    (object) =>
      (!filters.packageFilter ||
        object.packageName === filters.packageFilter) &&
      (!filters.objectFilter || object.objectRef === filters.objectFilter),
  );
  const allCandidateRefs = candidates.map((object) => object.objectRef);
  const countAudit =
    filters.customizedOnly && allCandidateRefs.length
      ? await loadAuditCounts(collection, allCandidateRefs, baseAudit)
      : baseAudit;
  const customized = customizedKeys(countAudit);
  const entries = candidates.flatMap((object) =>
    Object.entries(object.fields)
      .filter(
        ([fieldName]) =>
          !filters.customizedOnly ||
          customized.has(fieldPolicyCatalogItemId(object.objectRef, fieldName)),
      )
      .map(([fieldName, field]) => ({
        item: {
          id: fieldPolicyCatalogItemId(object.objectRef, fieldName),
          label: fieldName,
          ...(field.description ? { description: field.description } : {}),
          eyebrow: `${object.className} · ${object.packageName}`,
          objectRef: object.objectRef,
          fieldName,
          className: object.className,
          packageName: object.packageName,
        },
        search:
          `${fieldName} ${spaced(fieldName)} ${object.className} ${object.packageName} ${object.objectRef} ${field.description ?? ''}`.toLowerCase(),
      })),
  );
  const filtered = query
    ? entries.filter((entry) => entry.search.includes(query.toLowerCase()))
    : entries;
  const total = filtered.length;
  const page = clamp(
    options.page,
    1,
    Math.max(1, Math.ceil(total / pageSize)),
    1,
  );
  const items = filtered
    .slice((page - 1) * pageSize, page * pageSize)
    .map((entry) => entry.item);
  const selectedSummary =
    (options.selectedId
      ? filtered.find((entry) => entry.item.id === options.selectedId)?.item
      : undefined) ?? items[0];
  const selected = selectedSummary
    ? {
        ...selectedSummary,
        fields:
          objects.find(
            (object) => object.objectRef === selectedSummary.objectRef,
          )?.fields ?? {},
      }
    : null;
  const auditRefs = selected
    ? uniqueRefs([selected.objectRef, ...items.map((item) => item.objectRef)])
    : [];
  const audit = auditRefs.length
    ? await collection.policyAudit({
        objectRefs: auditRefs.slice(0, MAX_FIELD_POLICY_AUDIT_OBJECT_REFS),
        countObjectRefs: auditRefs,
        includeDrift: true,
      })
    : await collection.policyAudit({ includeDrift: true });
  return {
    page: { items, selected, query, page, pageSize, total },
    audit,
    objects: objects.map(({ objectRef, className, packageName, fields }) => ({
      objectRef,
      className,
      packageName,
      fieldCount: Object.keys(fields).length,
    })),
    packages: [...new Set(objects.map((object) => object.packageName))].sort(),
    filters,
  };
}

async function listCatalogObjects(
  objectRefs?: string[],
): Promise<CatalogObject[]> {
  const refs: string[] = objectRefs
    ? [...objectRefs]
    : Array.from(ObjectRegistry.getPublicClasses().values()).reduce<string[]>(
        (result, registered) => {
          if (registered.qualifiedName) result.push(registered.qualifiedName);
          return result;
        },
        [],
      );
  const unique = [...new Set(refs)].sort();
  const objects: CatalogObject[] = [];
  for (const objectRef of unique) {
    const registered = ObjectRegistry.getClassByQualifiedName(objectRef);
    if (
      !registered ||
      ObjectRegistry.getTableName(objectRef)?.startsWith('_smrt_')
    )
      continue;
    const fields = await getObjectFieldMap(objectRef);
    const selected: Record<string, FieldPolicyCatalogField> = {};
    for (const [name, definition] of fields) {
      if (
        SYSTEM_NAMES.has(name) ||
        !isPolicyAddressableField(definition) ||
        isSensitiveField(definition) ||
        isTransientField(definition) ||
        getFieldReadPermission(definition) !== undefined ||
        !FORM_TYPES.has(String(definition.type))
      )
        continue;
      selected[name] = {
        type: definition.type as FieldPolicyCatalogField['type'],
        ...(definition.required === true ? { required: true } : {}),
        ...(definition.default !== undefined
          ? { default: definition.default }
          : {}),
        ...(typeof definition.description === 'string'
          ? { description: definition.description }
          : {}),
      };
    }
    if (!Object.keys(selected).length) continue;
    const colon = objectRef.lastIndexOf(':');
    const packageName = colon === -1 ? '' : objectRef.slice(0, colon);
    const className = colon === -1 ? objectRef : objectRef.slice(colon + 1);
    objects.push({ objectRef, className, packageName, fields: selected });
  }
  return objects;
}

async function loadAuditCounts(
  collection: FieldPolicyCollection,
  refs: string[],
  baseline: FieldPolicyAuditSnapshot,
): Promise<FieldPolicyAuditSnapshot> {
  const userOverrideCounts: FieldPolicyAuditSnapshot['userOverrideCounts'] = {};
  const orgRows: FieldPolicyAuditSnapshot['orgRows'] = [];
  const appRows: FieldPolicyAuditSnapshot['appRows'] = [];
  const inheritedOrgKeys: FieldPolicyAuditSnapshot['inheritedOrgKeys'] = {};
  const chunkSize = MAX_FIELD_POLICY_AUDIT_OBJECT_REFS;
  for (let offset = 0; offset < refs.length; offset += chunkSize) {
    const audit = await collection.policyAudit({
      objectRefs: refs.slice(offset, offset + chunkSize),
      countObjectRefs: refs.slice(offset, offset + chunkSize),
      countsOnly: true,
    });
    for (const [objectRef, byField] of Object.entries(
      audit.userOverrideCounts,
    )) {
      userOverrideCounts[objectRef] = {
        ...(userOverrideCounts[objectRef] ?? {}),
        ...byField,
      };
    }
    orgRows.push(...audit.orgRows);
    appRows.push(...audit.appRows);
    for (const [objectRef, fieldNames] of Object.entries(
      audit.inheritedOrgKeys,
    )) {
      const names = inheritedOrgKeys[objectRef] ?? [];
      inheritedOrgKeys[objectRef] = names;
      for (const fieldName of fieldNames) {
        if (!names.includes(fieldName)) names.push(fieldName);
      }
    }
  }
  return {
    ...baseline,
    orgRows,
    appRows,
    inheritedOrgKeys,
    userOverrideCounts,
  };
}

function customizedKeys(audit: FieldPolicyAuditSnapshot): Set<string> {
  const keys = new Set<string>();
  for (const row of [...audit.orgRows, ...audit.appRows])
    keys.add(fieldPolicyCatalogItemId(row.objectRef, row.fieldName));
  for (const [objectRef, names] of Object.entries(audit.inheritedOrgKeys))
    for (const name of names)
      keys.add(fieldPolicyCatalogItemId(objectRef, name));
  for (const [objectRef, fields] of Object.entries(audit.userOverrideCounts))
    for (const [name, count] of Object.entries(fields))
      if (count > 0) keys.add(fieldPolicyCatalogItemId(objectRef, name));
  return keys;
}

function emptyPage(
  query: string,
  pageSize: number,
): FieldPolicySettingsCatalogPage {
  return { items: [], selected: null, query, page: 1, pageSize, total: 0 };
}
function uniqueRefs(refs: string[]): string[] {
  return [...new Set(refs)];
}
function stringFilter(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function integerParam(value: string | null): number | null {
  return value && /^\d+$/.test(value) ? Number(value) : null;
}
function clamp(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value as number)))
    : fallback;
}
function spaced(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
}
