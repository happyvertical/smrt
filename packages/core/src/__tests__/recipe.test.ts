/**
 * `SmrtRecipe` (#3590): the authoring base class, its two entry points, and
 * the knowledge-artifact projection of a manifest's `recipes`.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtRecipe as BrowserSmrtRecipe } from '../browser';
import { SmrtRecipe } from '../index';
import { buildDomainKnowledgeManifest } from '../knowledge.js';
import type { SmartObjectManifest } from '../scanner/types.js';

const execFileAsync = promisify(execFile);

class Order {
  constructor(readonly options: { id: string }) {}
}

class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Take customer orders.';
  static models = [Order];
  static nav = [{ label: 'Sales Orders', model: Order }];
  static requires = ['shop.customers'];
}

describe('SmrtRecipe', () => {
  it('is one class from both entries', () => {
    expect(BrowserSmrtRecipe).toBe(SmrtRecipe);
  });

  it('exposes declared statics and defaults the optional ones', () => {
    expect(SalesRecipe.id).toBe('shop.sales');
    expect(SalesRecipe.models).toEqual([Order]);
    expect(SalesRecipe.synonyms).toEqual([]);
    expect(SalesRecipe.options).toEqual({});
    expect(SalesRecipe.requiresAny).toEqual([]);
    expect(SalesRecipe.group).toBeUndefined();
    expect(SalesRecipe.section).toBeUndefined();
  });

  it('is exported through the package browser condition', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--conditions=browser',
        '--input-type=module',
        '-e',
        "import('@happyvertical/smrt-core').then(({ SmrtRecipe }) => console.log(typeof SmrtRecipe))",
      ],
      { cwd: new URL('../..', import.meta.url) },
    );
    expect(stdout.trim()).toBe('function');
  });
});

describe('recipes in the domain-knowledge artifact', () => {
  let rootDir: string;
  const recipe: RecipeDefinition = {
    id: 'shop.sales',
    className: 'SalesRecipe',
    label: 'Sales',
    summary: 'Take customer orders.',
    synonyms: [],
    models: ['@shop/pkg:Order'],
    nav: [{ label: 'Sales Orders', model: '@shop/pkg:Order' }],
    requires: [],
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-recipe-knowledge-'));
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: '@shop/pkg', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function build(recipes?: RecipeDefinition[]) {
    const manifest: SmartObjectManifest = {
      version: '1',
      timestamp: 1,
      packageName: '@shop/pkg',
      packageVersion: '1.0.0',
      objects: {},
      ...(recipes ? { recipes } : {}),
    };
    return buildDomainKnowledgeManifest({ manifest, rootDir });
  }

  it('projects the manifest recipes into the artifact', () => {
    expect(build([recipe]).recipes).toEqual([recipe]);
  });

  it('omits the key when a package declares none', () => {
    expect('recipes' in build()).toBe(false);
    expect('recipes' in build([])).toBe(false);
  });

  it('carries group, section, requiresAny and rich nav entries through', () => {
    const rich: RecipeDefinition = {
      ...recipe,
      group: { id: 'billing', label: 'Billing' },
      section: { id: 'sales', label: 'Sales', icon: 'shoppingBag' },
      requiresAny: [['shop.a', 'shop.b']],
      nav: [
        {
          label: 'Open',
          model: '@shop/pkg:Order',
          icon: 'receipt',
          key: 'open',
          filter: { field: 'status', value: 'open' },
        },
      ],
    };
    expect(build([rich]).recipes).toEqual([rich]);
  });

  it('carries surfaces, providers, runtime and demoSeed through (#3708)', () => {
    const surfaced: RecipeDefinition = {
      ...recipe,
      runtime: 'browser',
      surfaces: [
        {
          kind: 'shell-widget',
          slot: 'header.end',
          export: '@shop/pkg/svelte#Bell',
          label: 'Bell',
        },
      ],
      providers: [
        { id: 'mail', kind: 'email', options: ['smtp'], required: true },
      ],
      demoSeed: { data: { orders: [] } },
    };
    expect(build([surfaced]).recipes).toEqual([surfaced]);
  });

  it('changes the manifest hash when a recipe changes', () => {
    const before = build([recipe]).sourceHashes.manifest;
    const after = build([{ ...recipe, label: 'Selling' }]).sourceHashes
      .manifest;
    expect(after).not.toBe(before);
  });
});
