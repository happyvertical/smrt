/**
 * Cookbook validation against the recipe index (#3748): the structural check
 * lives in core (`validateCookbook`); this adds what needs manifests.
 */

import { parseCookbookText } from '@happyvertical/smrt-core/cookbook';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  candidatePackageForRecipe,
  packageOfQualifiedName,
  type RecipeIndex,
} from './recipe-index.js';

export interface CookbookReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cookbook?: Cookbook;
  /** Packages the cookbook's recipes, features and policies need. */
  packages: string[];
}

const unresolvedHint = (index: RecipeIndex, packageName: string) =>
  index.missing.has(packageName)
    ? ` (package ${packageName} could not be found; install it, pass --manifests, or check the registry)`
    : '';

/** Validate cookbook text structurally and against the recipe index. */
export function validateCookbookText(
  text: string,
  index: RecipeIndex,
): CookbookReport {
  // Recipe existence is checked here, with package-aware messages.
  const structural = parseCookbookText(text);
  if (!structural.ok) {
    return {
      ok: false,
      errors: structural.errors,
      warnings: [],
      packages: [],
    };
  }
  const cookbook = structural.cookbook;
  const errors: string[] = [];
  const warnings = [...structural.warnings];
  const packages = new Set<string>();
  const selected = new Set(cookbook.recipes);

  for (const id of cookbook.recipes) {
    const entry = index.recipes.get(id);
    if (!entry) {
      errors.push(
        `recipe "${id}" does not exist${unresolvedHint(index, candidatePackageForRecipe(id))}`,
      );
      continue;
    }
    packages.add(entry.packageName);
    for (const required of entry.requires) {
      if (!selected.has(required)) {
        errors.push(`recipe "${id}" requires "${required}", which is missing`);
      }
    }
    for (const group of entry.requiresAny) {
      if (!group.some((alt) => selected.has(alt))) {
        errors.push(
          `recipe "${id}" requires one of ${group.map((g) => `"${g}"`).join(', ')}, and none is present`,
        );
      }
    }
  }

  const checkObject = (ref: string, at: string): Set<string> | null => {
    const pkg = packageOfQualifiedName(ref);
    if (!pkg) {
      errors.push(`${at}: "${ref}" is not a qualified name (@scope/pkg:Class)`);
      return null;
    }
    const info = index.packages.get(pkg);
    if (!info) {
      errors.push(
        `${at}: package ${pkg} for "${ref}" is not resolvable${unresolvedHint(index, pkg)}`,
      );
      return null;
    }
    packages.add(pkg);
    const fields = info.objects.get(ref);
    if (!fields) {
      errors.push(`${at}: object "${ref}" does not exist in ${pkg}`);
      return null;
    }
    return fields;
  };

  (cookbook.features ?? []).forEach((ref, i) => {
    checkObject(ref, `features[${i}]`);
  });
  (cookbook.policies ?? []).forEach((policy, i) => {
    const at = `policies[${i}]`;
    const fields = checkObject(policy.objectRef, at);
    if (fields && !fields.has(policy.fieldName)) {
      errors.push(
        `${at}: field "${policy.fieldName}" does not exist on ${policy.objectRef}`,
      );
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    cookbook: errors.length === 0 ? cookbook : undefined,
    packages: [...packages].sort(),
  };
}

/** Cookbook shape needed to plan resolution before validation. */
export function parseForResolution(text: string): {
  recipes: string[];
  features: string[];
  policies: Array<{ objectRef?: string }>;
} {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const strings = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string')
        : [];
    return {
      recipes: strings(raw.recipes),
      features: strings(raw.features),
      policies: Array.isArray(raw.policies)
        ? raw.policies.filter(
            (p): p is { objectRef?: string } =>
              typeof p === 'object' && p !== null,
          )
        : [],
    };
  } catch {
    return { recipes: [], features: [], policies: [] };
  }
}
