import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HelpModel, renderHelp } from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { beforeAll, describe, expect, it } from 'vitest';

type Manifest = ReturnType<ManifestAdapter['toManifest']>;
const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Framework identity/audit fields are not visitor-editable fields. The tenancy
// decorator owns tenantId, which is supplied by the authenticated host.
const systemFields = new Set([
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
  'tenantId',
  'createdAt',
  'updatedAt',
]);

for (const [pkg, ids] of [
  ['assets', ['assets.library', 'assets.attachments']],
  ['chat', ['chat.rooms']],
] as const) {
  describe(`${pkg} visitor recipe metadata (#3769)`, () => {
    let manifest: Manifest;
    beforeAll(async () => {
      const scanner = new OxcScanner({
        cwd: resolve(packages, pkg),
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__tests__/**', '**/*.d.ts'],
      });
      const { results, resolved } = await scanner.scanAndResolve();
      expect(results.errors).toEqual([]);
      manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: `@happyvertical/smrt-${pkg}`,
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      manifest.smrtDependencies = Object.keys(
        JSON.parse(readFileSync(resolve(packages, pkg, 'package.json'), 'utf8'))
          .dependencies,
      ).filter((name) => name.startsWith('@happyvertical/smrt-'));
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: `@happyvertical/smrt-${pkg}`,
      });
    }, 60_000);

    it('emits distinct stable navigation identities and sentence case labels', () => {
      const nav =
        manifest.recipes
          ?.filter((r) => ids.some((id) => id === r.id))
          .flatMap((r) => r.nav ?? []) ?? [];
      const identities = nav.map((item) => `${item.model}:${item.key ?? ''}`);
      expect(new Set(identities).size).toBe(identities.length);
      if (pkg === 'assets')
        expect(nav.find((item) => item.label === 'Attachments')?.key).toBe(
          'attachments',
        );
      else expect(nav.map((item) => item.label)).toEqual(['Chat rooms']);
    });

    for (const id of ids) {
      it(`${id} gives every shown field a useful glossary entry`, () => {
        const recipe = manifest.recipes?.find((r) => r.id === id);
        expect(recipe?.help).toBeDefined();
        if (!recipe?.help) throw new Error(`Missing ${id} help`);
        const models: HelpModel[] = recipe.models.map((qualified) => {
          const model = Object.values(manifest.objects).find(
            (object) => object.qualifiedName === qualified,
          );
          if (!model) throw new Error(`Missing ${qualified}`);
          const hints = recipe.options?.[qualified]?.fields ?? {};
          return {
            id: qualified,
            name: model.className,
            fields: Object.entries(model.fields)
              .filter(
                ([name, field]) =>
                  !systemFields.has(name) &&
                  !field.transient &&
                  !field.sensitive,
              )
              .map(([name]) => ({
                name,
                label: hints[name]?.label ?? name,
                help: hints[name]?.help,
                visibility: hints[name]?.visibility ?? 'basic',
              })),
            descriptions: Object.fromEntries(
              Object.entries(model.fields).map(([name, field]) => [
                name,
                field.description ?? '',
              ]),
            ),
          };
        });
        const expected = models.flatMap((model) =>
          model.fields
            .filter((field) => field.visibility !== 'hidden')
            .map((field) => `${model.name}.${field.name}`),
        );
        const glossary = renderHelp(recipe.help, models, {
          showAdvanced: true,
        }).glossary;
        expect(
          glossary.map((entry) => `${entry.model}.${entry.name}`).sort(),
        ).toEqual(expected.sort());
        for (const entry of glossary) {
          expect(
            entry.text.length,
            `${entry.model}.${entry.name}`,
          ).toBeGreaterThan(20);
          expect(entry.text).not.toMatch(/\b(?:FK|JSON|MCP|CRUD)\b/);
        }
        // Curating help must continue to obey real model/field references.
        const generator = new ManifestGenerator();
        expect(() => generator.assertRecipeOptions(manifest)).not.toThrow();
        expect(() => generator.assertRecipeHelp(manifest)).not.toThrow();
      });
    }

    if (pkg === 'chat')
      it('advertises only mountable chat components, keeping fixture data as demoSeed', () => {
        const recipe = manifest.recipes?.find((r) => r.id === 'chat.rooms');
        expect(recipe?.surfaces).toEqual([
          {
            kind: 'route',
            path: '/chat/rooms',
            export: '@happyvertical/smrt-chat/svelte#ChatLayout',
            label: 'Team chat',
          },
        ]);
        const entry = readFileSync(
          resolve(packages, 'chat/src/svelte/index.ts'),
          'utf8',
        );
        expect(entry).toMatch(
          /export \{ default as ChatLayout \} from ['"].*\.svelte['"]/,
        );
        expect(recipe?.demoSeed?.export).toBe(
          '@happyvertical/smrt-chat/playground#chatRoomsFixture',
        );
      });
  });
}
