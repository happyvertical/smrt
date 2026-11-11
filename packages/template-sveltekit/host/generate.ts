/** Source customization points for a normal cookbook app, generated from installed manifests. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const sources = [...wanted]
    .filter((id) => !id.startsWith(`${pkg.name}:`))
    .sort()
    .map((id) => {
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

/** Prepare one verified installed-provider superset for both Vite generators. */
export async function prepareCookbookHost(
  options: {
    root?: string;
    objectsDir?: string;
    collectionAliases?: Readonly<Record<string, string>>;
  } = {},
) {
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const objectsDir = options.objectsDir ?? 'src/lib/objects';
  const subclasses = await generateCookbookSubclasses({ root, objectsDir });
  const manifests = (await readInstalledManifests(root)).filter(
    (manifest) => manifest.packageName !== '@happyvertical/smrt-core',
  );
  const providers = manifests.map((manifest) => manifest.packageName).sort();
  const catalog = catalogFromManifests(manifests);
  const cookbook = JSON.parse(
    await readFile(join(root, 'smrt.cookbook.json'), 'utf8'),
  );
  const expose = [
    ...new Set<string>([
      ...catalog.recipes.flatMap((recipe) => [
        ...recipe.models,
        ...recipe.nav.map((entry) => entry.model),
      ]),
      ...(cookbook.features ?? []),
    ]),
  ].sort();
  const require = createRequire(join(root, 'package.json'));
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const {
    smrtPlugin,
    serializeSmrtGenerationSnapshot,
    sha256SmrtGenerationSnapshot,
  } = await import('@happyvertical/smrt-core/vite-plugin');
  const {
    smrtConsumer,
    separateHostedStiCollections,
    aliasHostedCollections,
    findInstalledPackageJson,
  } = await import('@happyvertical/smrt-core/consumer-plugin');
  await mkdir(join(root, '.smrt'), { recursive: true });
  const entry = join(root, '.smrt/exposure-entry.js');
  await writeFile(entry, 'export {};\n');
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [
      smrtPlugin({
        projectRoot: root,
        include: [`${objectsDir}/**/*.ts`],
        generateTypes: false,
        svelteKit: { enabled: false, lazyActivation: true },
      }),
      smrtConsumer({
        projectRoot: root,
        packages: providers,
        generateTypes: false,
        svelteKit: false,
        lazyActivation: true,
      }),
    ],
    build: { write: false, rollupOptions: { input: entry } },
  });
  const manifest = aliasHostedCollections(
    separateHostedStiCollections(
      JSON.parse(await readFile(join(root, '.smrt/manifest.json'), 'utf8')),
      expose,
      (key, definition) => definition.qualifiedName ?? key,
    ),
    options.collectionAliases ?? {},
    expose,
  );
  // Linked provider sources may live outside the host. Snapshot paths are
  // portable under their common ancestor and verified by core on every use.
  let sourceRoot = root;
  const providerSourceRoots = new Map<string, string | undefined>();
  for (const definition of Object.values(manifest.objects) as Array<{
    filePath?: string;
    packageName?: string;
  }>) {
    if (!definition.filePath || !isAbsolute(definition.filePath)) continue;
    // A published manifest can name an existing publisher checkout. Only
    // source belonging to this installed provider (including workspace links)
    // may widen the snapshot root or contribute a source digest.
    if (
      definition.packageName &&
      definition.packageName !== manifest.packageName
    ) {
      if (!providerSourceRoots.has(definition.packageName)) {
        const metadata = findInstalledPackageJson(definition.packageName, root);
        providerSourceRoots.set(
          definition.packageName,
          metadata ? dirname(metadata) : undefined,
        );
      }
      const packageRoot = providerSourceRoots.get(definition.packageName);
      const path = packageRoot
        ? relative(packageRoot, definition.filePath)
        : '..';
      if (
        !packageRoot ||
        path === '..' ||
        path.startsWith(`..${sep}`) ||
        isAbsolute(path) ||
        !existsSync(definition.filePath)
      ) {
        delete definition.filePath;
        continue;
      }
    }
    while (relative(sourceRoot, definition.filePath).startsWith('..'))
      sourceRoot = dirname(sourceRoot);
  }
  const provenance = 'smrt-cookbook-host-v1';
  const contents = serializeSmrtGenerationSnapshot(manifest, provenance, {
    sourceRoot,
  });
  const sha256 = sha256SmrtGenerationSnapshot(contents);
  const snapshotPath = `.smrt/host-snapshots/${sha256.slice(7)}.json`;
  const generationSnapshot = {
    path: snapshotPath,
    sha256,
    provenance,
    sourceRoot,
  };
  await mkdir(join(root, '.smrt/host-snapshots'), { recursive: true });
  try {
    await writeFile(join(root, snapshotPath), contents, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await writeFile(
    join(root, '.smrt/host-options.json'),
    `${JSON.stringify(
      {
        packages: providers,
        expose,
        generationSnapshot,
      },
      null,
      2,
    )}\n`,
  );
  return { subclasses, providers, expose, generationSnapshot };
}

/** Vite entry for a complete lazy cookbook host, with no app-owned snapshot script. */
export async function cookbookHostVite(
  options: Parameters<typeof prepareCookbookHost>[0] = {},
): Promise<Array<{ name: string }>> {
  const prepared = await prepareCookbookHost(options);
  const { smrt } = await import('@happyvertical/smrt-core/vite');
  return smrt({
    projectRoot: options.root,
    objectsDir: options.objectsDir,
    packages: prepared.providers,
    expose: prepared.expose,
    generationSnapshot: prepared.generationSnapshot,
    lazyActivation: true,
  });
}
