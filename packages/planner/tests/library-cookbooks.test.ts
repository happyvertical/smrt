import { describe, expect, it } from 'vitest';
import type { Cookbook } from '../src/lib/cookbook/types.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import { createHeadlessPlanner } from '../src/lib/core/index.ts';
import { COOKBOOK_PACKS } from '../src/lib/data/packs.ts';
import { COOKBOOK_ICONS, libraryCookbooks } from '../src/lib/library/index.ts';
import { previewMenu } from '../src/lib/library/menu.ts';
import pendingFile from '../src/lib/library/pending.json' with { type: 'json' };
import type { LibraryCookbook, LibraryFile } from '../src/lib/library/types.ts';
import { recipesById } from '../src/lib/recipes/index.ts';
import {
  readSettings,
  settingsOfCookbook,
} from '../src/lib/settings/app-settings.ts';

/*
 * Every library cookbook, as data: the strict import check passes, its
 * settings read back as it declares them, its menu shows every entry it
 * renames, and the sample pack, icon and section blurbs it names exist. The
 * pending file holds cookbooks waiting on recipes smrt has not released; the
 * last test says when one is ready to move.
 */

const pending = pendingFile as unknown as LibraryFile & {
  awaiting: Record<string, { recipes: string[]; upstream: string }>;
};

/**
 * The planner's own `validate` command (smrt's cookbook engine over the
 * catalog): every policy names a field its model has, every id is known. The
 * same checks as `smrt cookbook validate`, so a smrt release that moves a
 * field (0.56's Contract split took `customerId` off ProductionOrder) fails
 * here rather than in a visitor's terminal. Returns the error diagnostics.
 */
function validationErrors(document: Cookbook): string[] {
  const result = createHeadlessPlanner(document).run({
    name: 'validate',
    input: {},
  });
  if (!result.ok) return [`${result.error.code}: ${result.error.message}`];
  const data = result.data as {
    diagnostics?: { severity: string; path?: string; message: string }[];
  };
  return (data.diagnostics ?? [])
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.path ?? ''} ${d.message}`.trim());
}

/** `custom:` section ids whose blurb every cookbook must spell the same way. */
function customDescriptions(cookbooks: readonly LibraryCookbook[]) {
  const seen = new Map<string, { cookbook: string; text: string }>();
  const clashes: string[] = [];
  for (const cookbook of cookbooks) {
    for (const [id, text] of Object.entries(
      cookbook.sectionDescriptions ?? {},
    )) {
      const first = seen.get(id);
      if (first && first.text !== text) {
        clashes.push(`${id}: ${first.cookbook} vs ${cookbook.id}`);
      } else if (!first) seen.set(id, { cookbook: cookbook.id, text });
    }
  }
  return clashes;
}

describe('library cookbooks', () => {
  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s passes the strict check and reads back its settings', (_id, cookbook) => {
    const result = parseCookbook(cookbook.document);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(readSettings(result.cookbook)).toEqual(
      settingsOfCookbook(cookbook.settings),
    );
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s validates against the catalog: every policy names a real field', (_id, cookbook) => {
    expect(validationErrors(cookbook.document)).toEqual([]);
  });

  it('the validation catches a policy on a field the model lacks', () => {
    const bakery = libraryCookbooks.find((c) => c.id === 'bakery');
    if (!bakery) throw new Error('bakery');
    const document = structuredClone(bakery.document);
    document.policies = [
      ...document.policies,
      {
        objectRef: '@happyvertical/smrt-commerce:ProductionOrder',
        fieldName: 'customerId',
        scopeType: 'app',
        visibility: 'hidden',
      },
    ];
    expect(validationErrors(document)).toEqual([
      expect.stringContaining('ProductionOrder has no field "customerId"'),
    ]);
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s shows every entry it renames and describes every custom section', (id, cookbook) => {
    const menu = previewMenu(cookbook.document);
    const shown = new Set(menu.flatMap((s) => s.entries.map((e) => e.id)));
    for (const item of Object.keys(cookbook.document.layout?.items ?? {})) {
      expect(shown.has(item), `${id} ${item}`).toBe(true);
    }
    const custom = new Set(
      (cookbook.document.layout?.customSections ?? []).map((s) => s.id),
    );
    const described = new Set(Object.keys(cookbook.sectionDescriptions ?? {}));
    expect([...custom].sort()).toEqual([...described].sort());
    for (const section of custom) {
      expect(
        cookbook.document.layout?.sections?.[section]?.icon,
        `${id} ${section} icon`,
      ).toBeTruthy();
    }
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s has an icon and a sample pack that agree with it', (id, cookbook) => {
    expect(COOKBOOK_ICONS[cookbook.icon], `${id} icon`).toBeTruthy();
    const pack = COOKBOOK_PACKS[id];
    expect(pack, `${id} pack`).toBeTruthy();
    expect(pack?.id).toBe(id);
    expect(pack?.terms?.[0]).toBe(cookbook.settings.paymentTerms);
    expect(pack?.customers?.length ?? 8).toBe(8);
    expect(pack?.vendors?.length ?? 5).toBe(5);
    if (cookbook.document.recipes.includes('events.calendar')) {
      expect(pack?.eventNames?.length, `${id} event names`).toBe(8);
      expect(pack?.eventTypes?.length, `${id} event types`).toBe(8);
    }
  });

  it('spells a shared custom section blurb one way', () => {
    expect(customDescriptions(libraryCookbooks)).toEqual([]);
  });

  it('keeps ids unique across the library and the pending file', () => {
    const ids = [...libraryCookbooks, ...pending.cookbooks].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('pending cookbooks', () => {
  it.each(
    pending.cookbooks.map((c) => [c.id, c] as const),
  )('%s is still waiting on exactly the recipes the file names', (id, cookbook) => {
    const awaited = pending.awaiting[id];
    expect(awaited, `${id} has no awaiting entry`).toBeTruthy();
    const missing = cookbook.document.recipes.filter(
      (recipe) => !recipesById.has(recipe),
    );
    expect(
      missing,
      `${id}: the catalog now carries every recipe it needs; move it from pending.json into library.json`,
    ).not.toEqual([]);
    expect(missing.sort()).toEqual([...awaited.recipes].sort());
    // Everything but the awaited recipes already holds up.
    const result = parseCookbook(cookbook.document, {
      dropUnknownRecipes: true,
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    // ...and the catalog validation finds nothing but the awaited recipes.
    if (result.ok) {
      expect(
        validationErrors(result.cookbook)
          .map((e) =>
            e.replace(/^recipes\[\d+\] Unknown recipe "(.+)"\.$/, '$1'),
          )
          .sort(),
      ).toEqual([...awaited.recipes].sort());
    }
    expect(COOKBOOK_ICONS[cookbook.icon], `${id} icon`).toBeTruthy();
    expect(COOKBOOK_PACKS[id]?.id).toBe(id);
    expect(customDescriptions([...libraryCookbooks, cookbook])).toEqual([]);
  });
});
