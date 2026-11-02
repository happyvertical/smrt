import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestGenerator } from '@happyvertical/smrt-core/manifest';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalEvent,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalsRecipe,
} from '../index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@happyvertical/smrt-approvals';

describe('approvals recipe (#4409)', () => {
  it('declares Approvals over the request, event and policy models', () => {
    expect(ApprovalsRecipe.id).toBe('approvals.requests');
    expect(ApprovalsRecipe.label).toBe('Approvals');
    expect(ApprovalsRecipe.models).toEqual([
      ApprovalRequest,
      ApprovalEvent,
      ApprovalPolicy,
    ]);
    expect(ApprovalsRecipe.exposure).toBeUndefined();
    expect(ApprovalsRecipe.section?.id).toBe('approvals');
  });

  describe('scanned and emitted', () => {
    let recipes: RecipeDefinition[];
    let errors: string[];
    let objects: Record<
      string,
      { decoratorConfig?: { api?: { include?: string[] } } }
    >;

    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: packageRoot,
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      errors = results.errors
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.filePath}: ${diagnostic.message}`);
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: PACKAGE,
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: PACKAGE,
        packageJson: JSON.parse(
          readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
        ),
      });
      recipes = manifest.recipes ?? [];
      objects = manifest.objects as typeof objects;
    });

    it('passes scanner validation', () => {
      expect(errors).toEqual([]);
    });

    it('emits the recipe with its label and read-only help', () => {
      const recipe = recipes.find((entry) => entry.id === 'approvals.requests');
      expect(recipe?.label).toBe('Approvals');
      expect(recipe?.exposure).toBeUndefined();
      expect(recipe?.help?.markdown).toContain('## Overview');
      expect(recipe?.help?.markdown).toMatch(/through the approval\s+service/);
      expect(recipe?.help?.markdown).not.toContain('**New**');
      expect(recipe?.help?.fieldRefs.length).toBeGreaterThan(0);
    });

    it('lists only exposed, read-only models in nav', () => {
      const recipe = recipes.find((entry) => entry.id === 'approvals.requests');
      expect(recipe?.nav.map((entry) => entry.label)).toEqual([
        'Requests',
        'History',
        'Policies',
      ]);
      for (const entry of recipe?.nav ?? []) {
        const name = entry.model.slice(entry.model.indexOf(':') + 1);
        const object = objects[name] ?? objects[entry.model];
        expect(object, entry.model).toBeDefined();
        expect(object.decoratorConfig?.api?.include ?? []).toEqual([
          'list',
          'get',
        ]);
      }
    });
  });
});
