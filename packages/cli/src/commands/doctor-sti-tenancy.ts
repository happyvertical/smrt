/**
 * `smrt doctor`: STI families whose members' tenancy differs (#5375).
 *
 * A route to an STI model serves rows of a family member only when the
 * member's tenancy equals the route model's (same scoping, mode, ownership
 * field and super-admin bypass opt-in). A member with any other tenancy is
 * not served through the base: its rows leave the base's lists and counts,
 * point reads answer 404, and a sync segment the family shares no longer
 * applies its items. The runtime warns once per such family; this section
 * lists the families the project manifest declares, so the gap is visible
 * before a request finds it.
 *
 * Tenancy registered only at run time (`registerTenantScopedClass()`) is not
 * in the manifest; the runtime warning covers it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** One family the section reports. */
export interface MixedTenancyFamilyFinding {
  /** Manifest key of the STI table owner. */
  family: string;
  /** Members whose tenancy differs from the owner's. */
  excluded: string[];
}

/** What the doctor section contributes to the summary. */
export interface StiTenancyDoctorSection {
  applies: boolean;
  lines: string[];
  warnings: string[];
  passed: string[];
  families: MixedTenancyFamilyFinding[];
}

interface ManifestObject {
  className?: string;
  qualifiedName?: string;
  extends?: string;
  decoratorConfig?: {
    tableStrategy?: unknown;
    tenantScoped?: unknown;
  };
}

/** The normalized tenancy a declaration resolves to, or `null`. */
function declaredPolicy(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === false || value === null) return null;
  const config =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return JSON.stringify([
    config.mode === 'optional' ? 'optional' : 'required',
    typeof config.field === 'string' && config.field
      ? config.field
      : 'tenantId',
    config.allowSuperAdminBypass === true,
  ]);
}

/**
 * The STI families of a manifest whose members' declared tenancy differs
 * from the table owner's. A member without a declaration of its own
 * inherits its nearest declared ancestor's.
 */
export function findMixedTenancyFamilies(manifest: {
  objects?: Record<string, ManifestObject>;
}): MixedTenancyFamilyFinding[] {
  const objects = manifest.objects ?? {};
  const byName = new Map<string, [string, ManifestObject]>();
  for (const [key, object] of Object.entries(objects)) {
    byName.set(key, [key, object]);
    if (object.qualifiedName) byName.set(object.qualifiedName, [key, object]);
    if (object.className && !byName.has(object.className)) {
      byName.set(object.className, [key, object]);
    }
  }
  const parentOf = (object: ManifestObject) =>
    object.extends ? byName.get(object.extends) : undefined;
  const chainOf = (key: string): Array<[string, ManifestObject]> => {
    const chain: Array<[string, ManifestObject]> = [];
    const seen = new Set<string>();
    let entry = byName.get(key);
    while (entry && !seen.has(entry[0])) {
      seen.add(entry[0]);
      chain.push(entry);
      entry = parentOf(entry[1]);
    }
    return chain;
  };
  const policyOf = (key: string): string | null => {
    for (const [, object] of chainOf(key)) {
      const declared = declaredPolicy(object.decoratorConfig?.tenantScoped);
      if (declared !== undefined) return declared;
    }
    return null;
  };
  const ownerOf = (key: string): string | undefined => {
    let owner: string | undefined;
    for (const [entryKey, object] of chainOf(key)) {
      if (object.decoratorConfig?.tableStrategy === 'sti') owner = entryKey;
    }
    return owner;
  };

  const families = new Map<string, string[]>();
  for (const key of Object.keys(objects)) {
    const owner = ownerOf(key);
    if (!owner || owner === key) continue;
    if (policyOf(key) === policyOf(owner)) continue;
    const excluded = families.get(owner) ?? [];
    excluded.push(key);
    families.set(owner, excluded);
  }
  return [...families]
    .map(([family, excluded]) => ({ family, excluded: excluded.sort() }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** Run the check against the project manifest and shape it for doctor. */
export function runStiTenancyDoctorSection(
  cwd: string,
): StiTenancyDoctorSection {
  const manifestPath = resolve(cwd, '.smrt', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      applies: false,
      lines: [],
      warnings: [],
      passed: [],
      families: [],
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    objects?: Record<string, ManifestObject>;
  };
  const families = findMixedTenancyFamilies(manifest);
  if (families.length === 0) {
    return {
      applies: true,
      lines: ['   ✅ Every STI family shares its owner tenancy'],
      warnings: [],
      passed: ['STI family tenancy'],
      families,
    };
  }
  const warnings = families.map(
    ({ family, excluded }) =>
      `STI family ${family}: ${excluded.join(', ')} ` +
      `${excluded.length === 1 ? 'has' : 'have'} a tenancy that differs from ${family}, ` +
      `so ${family}'s routes do not serve ${excluded.length === 1 ? 'its' : 'their'} rows. ` +
      'Give the subtype its own route or sync segment, or align its tenancy.',
  );
  return {
    applies: true,
    lines: warnings.map((warning) => `   ⚠️  ${warning}`),
    warnings,
    passed: [],
    families,
  };
}
