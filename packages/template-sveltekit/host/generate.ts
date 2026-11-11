/** Source customization points for a normal cookbook app, generated from installed manifests. */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateCookbook } from '@happyvertical/smrt-core/cookbook';
import {
  catalogFromManifests,
  readInstalledManifests,
} from '@happyvertical/smrt-svelte/cookbook/server';

/** Generate empty same-name subclasses once; never overwrite the person's extensions. */
export async function generateCookbookSubclasses(
  options: { root?: string; objectsDir?: string } = {},
) {
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^@[^/]+\/[^/]+$/.test(pkg.name ?? ''))
    throw new Error('App subclasses need a scoped package name');
  const directory = resolve(root, options.objectsDir ?? 'src/lib/objects');
  const path = relative(root, directory);
  if (path.startsWith('..') || isAbsolute(path))
    throw new Error('objectsDir must be inside the app');
  const manifests = await readInstalledManifests(root);
  const catalog = catalogFromManifests(manifests);
  const checked = validateCookbook(
    JSON.parse(await readFile(join(root, 'smrt.cookbook.json'), 'utf8')),
    { recipes: catalog.recipes.map((r) => r.id) },
  );
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  const wanted = new Set(checked.cookbook.features ?? []);
  for (const recipe of catalog.recipes)
    if (checked.cookbook.recipes.includes(recipe.id)) {
      for (const model of recipe.models) wanted.add(model);
      for (const nav of recipe.nav) wanted.add(nav.model);
    }
  const names = new Map<string, string>();
  const sources = [...wanted].sort().map((id) => {
    const model = catalog.models.find((m) => m.id === id);
    if (!model) throw new Error(`Installed model is missing: ${id}`);
    const previous = names.get(model.name);
    if (previous && previous !== id)
      throw new Error(
        `App identity collision: ${previous} and ${id} both need ${pkg.name}:${model.name}`,
      );
    names.set(model.name, id);
    const manifest = manifests.find((m) =>
      Object.values(m.objects ?? {}).some((raw) => raw.qualifiedName === id),
    );
    const raw = Object.values(manifest?.objects ?? {}).find(
      (raw) => raw.qualifiedName === id,
    ) as { importPath?: string; exportName?: string } | undefined;
    const importPath = raw?.importPath ?? manifest?.packageName;
    const exportName = raw?.exportName ?? model.name;
    if (
      !importPath ||
      !/^@[\w-]+\/[\w-]+(?:\/[\w.-]+)*$/.test(importPath) ||
      importPath.split('/').includes('..') ||
      !/^[\w-]+$/.test(model.packageId) ||
      !/^[A-Za-z_$][\w$]*$/.test(exportName) ||
      !/^[A-Za-z_$][\w$]*$/.test(model.name)
    )
      throw new Error(`Model has no safe public import: ${id}`);
    return {
      file: join(directory, model.packageId, `${model.name}.ts`),
      source: `import { ${exportName} as ${model.name}Base } from '${importPath}';\nimport { smrt } from '@happyvertical/smrt-core';\n\n@smrt({})\nexport class ${model.name} extends ${model.name}Base {}\n`,
    };
  });
  const written: string[] = [];
  const existing: string[] = [];
  for (const { file, source } of sources) {
    let ancestor = resolve(file, '..');
    for (;;) {
      try {
        const at = relative(root, await realpath(ancestor));
        if (at.startsWith('..') || isAbsolute(at))
          throw new Error('objectsDir must resolve inside the app');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        ancestor = resolve(ancestor, '..');
      }
    }
    await mkdir(resolve(file, '..'), { recursive: true });
    try {
      await writeFile(file, source, { flag: 'wx' });
      written.push(relative(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      existing.push(relative(root, file));
    }
  }
  return { written, existing };
}
