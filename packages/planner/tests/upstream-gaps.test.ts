import { describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
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
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const entry of UPSTREAM_GAPS.undescribedModel) {
      expect(ids.has(entry.split(' ')[0])).toBe(true);
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
});
