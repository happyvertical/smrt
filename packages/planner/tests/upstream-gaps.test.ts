import { describe, expect, it } from 'vitest';
import raw from '../src/lib/catalog/catalog.json' with { type: 'json' };
import { catalog } from '../src/lib/catalog/index.ts';
import type { Catalog } from '../src/lib/catalog/types.ts';
import { recipeNav, recipes } from '../src/lib/recipes/index.ts';
import { navItemId } from '../src/lib/recipes/sections.ts';
import { UPSTREAM_GAPS } from './upstream-gaps.ts';

describe('upstream gap ledger', () => {
  it('names only recipes the catalog carries', () => {
    const ids = new Set(recipes.map((r) => r.id));
    for (const id of UPSTREAM_GAPS.titleCaseLabel)
      expect(ids.has(id)).toBe(true);
    for (const id of [
      ...UPSTREAM_GAPS.helpRefsHiddenField,
      ...UPSTREAM_GAPS.developerVocabulary,
      ...UPSTREAM_GAPS.fewMatchTerms,
      ...UPSTREAM_GAPS.sharedRecipeLabel,
      ...UPSTREAM_GAPS.noSection,
      ...UPSTREAM_GAPS.undescribedNavEntry,
      ...UPSTREAM_GAPS.unstructuredHelp,
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const entry of [
      ...UPSTREAM_GAPS.undescribedModel,
      ...UPSTREAM_GAPS.undescribedField,
    ]) {
      expect(ids.has(entry.split(' ')[0]), entry).toBe(true);
    }
  });

  it('expires: each gap still exists', () => {
    for (const id of UPSTREAM_GAPS.titleCaseLabel) {
      const recipe = recipes.find((r) => r.id === id);
      expect(
        recipe?.nav.some((e) => / [A-Z]/.test(e.label)),
        `${id} is fixed upstream; delete its entry`,
      ).toBe(true);
    }
    for (const gap of UPSTREAM_GAPS.sharedNavId) {
      const labels = new Set<string>();
      for (const recipe of recipes) {
        for (const e of recipeNav(recipe)) {
          if (navItemId(e.packageId, e.model.name, e.key) === gap) {
            labels.add(e.label);
          }
        }
      }
      expect(
        labels.size,
        `${gap} is fixed upstream; delete its entry`,
      ).toBeGreaterThan(1);
    }
  });

  it('expires: the other gaps still exist too', () => {
    for (const id of UPSTREAM_GAPS.developerVocabulary) {
      const help = recipes.find((r) => r.id === id)?.help?.markdown ?? '';
      expect(
        /\b(REST|MCP|CLI|API|JSON|UUID)\b/.test(help),
        `${id} is fixed upstream; delete its entry`,
      ).toBe(true);
    }
    const systemField = (ref: string) => {
      const [model, field] = ref.split('.');
      return catalog.packages
        .flatMap((p) => p.models)
        .some(
          (m) =>
            m.name === model &&
            m.fields.some((f) => f.name === field && f.system),
        );
    };
    for (const id of UPSTREAM_GAPS.helpRefsHiddenField) {
      const refs = recipes.find((r) => r.id === id)?.help?.fieldRefs ?? [];
      expect(
        refs.some(systemField),
        `${id} is fixed upstream; delete its entry`,
      ).toBe(true);
    }
    for (const entry of UPSTREAM_GAPS.undescribedModel) {
      const [id, name] = entry.split(' ');
      const model = catalog.packages
        .flatMap((p) => p.models)
        .find(
          (m) =>
            m.name === name &&
            recipes.find((r) => r.id === id)?.models.includes(m.id),
        );
      expect(model, entry).toBeDefined();
      expect(
        model?.fields.some((f) => !f.system && f.description),
        `${entry} is described upstream now; delete its entry`,
      ).toBe(false);
    }
  });
  it('expires: STI leaves still lose their discriminator enumeration', () => {
    // `upstream/overlay.ts` lends a leaf its ancestor's enumeration; delete
    // that once the manifest carries it on the leaves again.
    const leaf = (raw as unknown as Catalog).packages
      .flatMap((p) => p.models)
      .find((m) => m.id === '@happyvertical/smrt-commerce:ProductionOrder');
    const field = leaf?.fields.find((f) => f.name === 'contractType');
    expect(field, 'contractType missing').toBeDefined();
    expect(
      field?.enum,
      'leaves carry contractType values upstream now; delete the inherited enumeration in upstream/overlay.ts',
    ).toBeUndefined();
    // The overlay gives it back.
    const shown = catalog.packages
      .flatMap((p) => p.models)
      .find((m) => m.id === leaf?.id)
      ?.fields.find((f) => f.name === 'contractType');
    expect(shown?.enum).toContain('production_order');
  });

  it('expires: the smrt 0.56 gaps still exist', () => {
    const recipe = (id: string) => recipes.find((r) => r.id === id);
    for (const entry of UPSTREAM_GAPS.undescribedField) {
      const [id, ref] = entry.split(' ');
      const [name, field] = ref.split('.');
      const model = catalog.packages
        .flatMap((p) => p.models)
        .find((m) => m.name === name && recipe(id)?.models.includes(m.id));
      const found = model?.fields.find((f) => f.name === field);
      expect(found, entry).toBeDefined();
      expect(
        found?.description,
        `${entry} is described upstream now; delete its entry`,
      ).toBeUndefined();
    }
    for (const id of UPSTREAM_GAPS.fewMatchTerms) {
      expect(
        recipe(id)?.synonyms ?? [],
        `${id} has synonyms upstream now; delete its entry`,
      ).toEqual([]);
    }
    for (const id of UPSTREAM_GAPS.sharedRecipeLabel) {
      const label = recipe(id)?.label;
      expect(
        recipes.some((r) => r.id !== id && r.label === label),
        `${id} has a label of its own upstream now; delete its entry`,
      ).toBe(true);
    }
    for (const id of UPSTREAM_GAPS.noSection) {
      expect(
        recipe(id)?.section,
        `${id} suggests a section upstream now; delete its entry`,
      ).toBeUndefined();
    }
    for (const id of UPSTREAM_GAPS.undescribedNavEntry) {
      expect(
        recipe(id)?.nav.some((e) => !e.description),
        `${id} describes its menu entries upstream now; delete its entry`,
      ).toBe(true);
    }
    for (const id of UPSTREAM_GAPS.unstructuredHelp) {
      const markdown = recipe(id)?.help?.markdown ?? '';
      expect(
        /^(#{2,3} |\s*(?:[-*]|\d+\.) )/m.test(markdown),
        `${id} has sections or tasks upstream now; delete its entry`,
      ).toBe(false);
    }
  });
});
