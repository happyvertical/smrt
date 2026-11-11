/** Independent cold processes; in-process SQLite; no HTTP server or containers.
 * Run after pnpm build: node packages/core/scripts/benchmark-activation.mjs [--real] [--runs=3]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const core = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(core, '../..');
const childDirectory = process.argv.find((arg) => arg.startsWith('--child='))?.slice(8);
if (childDirectory) {
  const { ObjectRegistry } = await import('../dist/index.js');
  const { createActivationCoordinator } = await import('../dist/activation.js');
  const { getDatabase } = await import('@happyvertical/sql');
  const { activationManifest, activationLoaders } = await import(pathToFileURL(join(childDirectory, 'register.js')).href);
  const selection = JSON.parse(readFileSync(join(childDirectory, 'selection.json'), 'utf8'));
  const all = process.argv.includes('--all');
  const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  try {
    const coordinator = createActivationCoordinator({ scope: 'benchmark', db, packageName: '@activation/benchmark', manifest: activationManifest, loaders: activationLoaders, alwaysOn: selection.alwaysOn, readEnabled: async () => all ? selection.all : selection.subset });
    await coordinator.boot();
    const tables = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows;
    const rssMiB = process.memoryUsage().rss / 1048576;
    const models = ObjectRegistry.getAllClasses().size;
    process.stdout.write('activation-ready\n');
    const nextWasReady = selection.next.every((model) => coordinator.isReady(model));
    const started = performance.now();
    await coordinator.activate(selection.next);
    const enableMs = performance.now() - started;
    const after = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).rows;
    console.log(JSON.stringify({ tables: tables.length, applicationTables: tables.filter(({ name }) => !name.startsWith('_smrt_') && !name.startsWith('sqlite_')).length, registeredModels: models, rssMiB: +rssMiB.toFixed(2), nextRecipe: selection.nextRecipe, nextWasReady, enableMs: +enableMs.toFixed(2), tablesAfterEnable: after.length, registeredModelsAfterEnable: ObjectRegistry.getAllClasses().size }));
  } finally { await db.close?.(); }
} else {
  const directory = mkdtempSync(join(tmpdir(), 'smrt-activation-benchmark-'));
  const real = process.argv.includes('--real');
  const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 3);
  const { generateActivationRegistration } = await import('../dist/activation/generate.js');
  const { manifestExportCandidates } = await import('../dist/manifest/package-manifest-exports.js');
  const packages = new Map();
  const link = (name, target) => {
    const path = join(directory, 'node_modules', name);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) symlinkSync(target, path, 'dir');
  };
  link('@happyvertical/smrt-core', core);
  let objects = {}; let recipes = []; let selection;
  try {
    if (real) {
      for (const folder of readdirSync(join(repository, 'packages'))) {
        const path = join(repository, 'packages', folder);
        if (!existsSync(join(path, 'package.json'))) continue;
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
        const manifestPath = manifestExportCandidates(path, pkg).find((candidate) => candidate.endsWith('.json') && existsSync(candidate));
        if (!manifestPath) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        packages.set(pkg.name, { path, manifest });
        link(pkg.name, path);
      }
      const recipePackages = [...packages].filter(([, { manifest }]) => manifest.recipes?.length).map(([name]) => name);
      const included = new Set();
      const include = (name) => {
        if (included.has(name) || name === '@happyvertical/smrt-core') return;
        const provider = packages.get(name);
        if (!provider) {
          // Dependency inventories also contain type/utility-only packages.
          const utility = readdirSync(join(repository, 'packages')).some((folder) => {
            const file = join(repository, 'packages', folder, 'package.json');
            if (!existsSync(file)) return false;
            const pkg = JSON.parse(readFileSync(file, 'utf8'));
            return pkg.name === name && !pkg.exports?.['./manifest.json'] && !pkg.exports?.['./manifest'];
          });
          if (utility) return;
          throw new Error(`Missing built manifest: ${name}`);
        }
        included.add(name);
        Object.assign(objects, Object.fromEntries(Object.entries(provider.manifest.objects).filter(([, entry]) => !entry.packageName || entry.packageName === name).map(([key, entry]) => [key.includes(':') ? key : `${name}:${entry.className}`, { ...entry, packageName: entry.packageName ?? name }])));
        recipes.push(...provider.manifest.recipes ?? []);
        for (const dependency of provider.manifest.smrtDependencies ?? []) include(dependency);
        // Cross-package refs can name optional providers outside package.json's
        // eager import graph; the activation superset must still contain them.
        for (const entry of Object.values(provider.manifest.objects)) {
          const parent = entry.extendsQualified?.split(':')[0];
          if (parent && packages.has(parent)) include(parent);
          for (const field of Object.values(entry.fields ?? {})) {
            if ((field.type === 'foreignKey' || field.type === 'crossPackageRef') && field.related?.includes(':')) include(field.related.split(':')[0]);
          }
        }
      };
      for (const name of recipePackages) include(name);
      const cookbook = JSON.parse(readFileSync(join(core, 'src/cookbook/__fixtures__/yoga-studio.cookbook.json'), 'utf8'));
      const recipeMap = new Map(recipes.map((recipe) => [recipe.id, recipe]));
      const selected = new Set();
      const enable = (id) => {
        if (selected.has(id)) return;
        const recipe = recipeMap.get(id);
        if (!recipe) throw new Error(`Unknown yoga recipe: ${id}`);
        selected.add(id);
        for (const dependency of recipe.requires ?? []) enable(dependency);
      };
      for (const id of cookbook.recipes) enable(typeof id === 'string' ? id : id.id);
      const models = (ids) => [...new Set([...ids].flatMap((id) => recipeMap.get(id).models))];
      selection = { alwaysOn: ['@happyvertical/smrt-users:User'], subset: models(selected), all: models(recipeMap.keys()), nextRecipe: 'education.catalog', next: models(['education.catalog']) };
      // Content's declared serializer is a host $lib integration. Supply the
      // existing implementation, as a real host would, without changing its graph.
      mkdirSync(join(directory, 'src/lib/server'), { recursive: true });
      writeFileSync(join(directory, 'src/lib/server/content-api-serializers.ts'), `export { serializeContent } from ${JSON.stringify(join(repository, 'packages/content/src/serialization.ts'))};\n`);
      console.log(JSON.stringify({ fixture: 'real', recipePackages: recipePackages.length, providers: included.size, manifestEntries: Object.keys(objects).length }));
    } else {
      // 34 recipe-like modules, 204 physical tables, 12 business fields/model,
      // and real static module + cross-package FK dependencies. No fake DDL.
      for (let pkg = 0; pkg < 34; pkg++) {
        const name = `@activation/recipe-${pkg}`;
        const root = join(directory, 'node_modules', name);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
        let source = `import { SmrtObject } from '@happyvertical/smrt-core';\n${pkg ? "import '@activation/recipe-0';\n" : ''}`;
        for (let model = 0; model < 6; model++) {
          const className = `Record${pkg}_${model}`;
          const id = `${name}:${className}`;
          source += `export class ${className} extends SmrtObject {}\n`;
          const fields = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`value${n}`, { type: n % 2 ? 'integer' : 'text' }]));
          const columns = { id: { type: 'TEXT', primaryKey: true }, ...Object.fromEntries(Object.keys(fields).map((field, n) => [field.replace(/(\d+)$/, '_$1'), { type: n % 2 ? 'INTEGER' : 'TEXT' }])) };
          if (pkg) {
            fields.parentId = { type: 'crossPackageRef', related: '@activation/recipe-0:Record0_0' };
            columns.parent_id = { type: 'TEXT', foreignKey: { table: 'recipe_0_0', column: 'id' } };
          }
          objects[id] = { name: className.toLowerCase(), className, qualifiedName: id, packageName: name, importPath: name, filePath: join(root, 'index.js'), collection: `recipe_${pkg}_${model}`, extends: 'SmrtObject', fields, methods: {}, decoratorConfig: { tableName: `recipe_${pkg}_${model}` }, schema: { tableName: `recipe_${pkg}_${model}`, columns, indexes: [], ddl: '', version: 'fixture' } };
        }
        writeFileSync(join(root, 'index.js'), source);
      }
      const models = (pkgs) => Object.keys(objects).filter((id) => pkgs.some((pkg) => id.startsWith(`@activation/recipe-${pkg}:`)));
      selection = { alwaysOn: models([0]), subset: models([1, 2]), all: Object.keys(objects), next: models([3]) };
      console.log(JSON.stringify({ fixture: 'synthetic', recipePackages: 34, manifestEntries: 204 }));
    }
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@activation/benchmark', type: 'module' }));
    const generated = generateActivationRegistration({ version: '1', timestamp: 0, packageName: '@activation/benchmark', objects }, { projectRoot: directory, outputDir: directory });
    writeFileSync(join(directory, 'register.js'), generated.source);
    writeFileSync(join(directory, 'selection.json'), JSON.stringify(selection));
    for (const all of [false, true]) {
      for (let run = 1; run <= runs; run++) {
        const started = performance.now();
        const row = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--child=${directory}`, ...(all ? ['--all'] : [])], { env: { ...process.env, SMRT_DEFAULT_AI_PROVIDER: 'none' } });
          let output = ''; let errors = ''; let coldStartMs;
          child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk) => { output += chunk; if (coldStartMs === undefined && output.includes('activation-ready\n')) coldStartMs = Math.round(performance.now() - started); });
          child.stderr.on('data', (chunk) => { errors += chunk; });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0 || coldStartMs === undefined) return reject(new Error((errors || output).slice(-5000)));
            resolve({ mode: all ? 'all' : 'subset', run, coldStartMs, ...JSON.parse(output.trim().split('\n').at(-1)) });
          });
        });
        console.log(JSON.stringify(row));
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
