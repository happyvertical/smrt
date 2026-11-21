import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
);
const workspaceDependencies = Object.entries(manifest.dependencies ?? {}).filter(
  ([, version]) => version.startsWith('workspace:'),
);

// Newest modification time (ms) of any file under `directory`; 0 when absent.
function newestMtime(directory) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return 0;
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
}

if (workspaceDependencies.length === 0) {
  // pnpm rewrites workspace ranges when packing. Published installs use dist.
  for (const field of ['main', 'types']) {
    const artifact = manifest[field];
    if (
      typeof artifact !== 'string' ||
      !statSync(resolve(packageDir, artifact), { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error(`Products prepare: missing compiled ${field} artifact (${artifact}); install a complete published package or build from the workspace source.`);
    }
  }
} else {
  const missing = [];
  const builtOutputs = [];
  for (const [name] of workspaceDependencies) {
    const dependencyDir = resolve(packageDir, 'node_modules', name);
    // Read directly: package exports may hide package.json, and missing installed
    // dependencies are errors rather than a reason to defer the build.
    const dependency = JSON.parse(
      readFileSync(resolve(dependencyDir, 'package.json'), 'utf8'),
    );
    if (dependency.name !== name) {
      throw new Error(`Products prepare: expected installed workspace dependency ${name}, received ${dependency.name}`);
    }
    const output = resolve(dependencyDir, 'dist');
    const stats = statSync(output, { throwIfNoEntry: false });
    if (stats && !stats.isDirectory()) {
      throw new Error(`Products prepare: ${name}/dist must be a build output directory`);
    }
    const artifacts = [dependency.main, dependency.types];
    if (name === '@happyvertical/smrt-core') {
      const plugin = dependency.exports?.['./vite-plugin'];
      artifacts.push(plugin?.import, plugin?.types);
    }
    builtOutputs.push([name, dependencyDir]);
    for (const artifact of artifacts) {
      if (typeof artifact !== 'string' || artifact.length === 0) {
        throw new Error(`Products prepare: ${name} must declare main/types build outputs and core must declare vite-plugin import/types exports`);
      }
      if (!statSync(resolve(dependencyDir, artifact), { throwIfNoEntry: false })?.isFile()) {
        missing.push(`${name}/${artifact.replace(/^\.\//, '')}`);
      }
    }
  }
  // Built outputs that predate their sources (for example after a rebase that
  // changed the dependency's API) cannot build products; defer to `pnpm build`,
  // which rebuilds dependencies first.
  const stale = [];
  if (missing.length === 0) {
    for (const [name, dependencyDir] of builtOutputs) {
      const sources = newestMtime(resolve(dependencyDir, 'src'));
      // Compare with the newest output: builds also write generated files into
      // src/ while they run, which land after the first emitted artifacts.
      const outputs = newestMtime(resolve(dependencyDir, 'dist'));
      if (sources === 0 || outputs === 0) continue;
      if (sources > outputs) stale.push(name);
    }
  }
  if (missing.length > 0) {
    console.log(`Deferring products build; missing workspace build outputs: ${missing.join(', ')}. Run pnpm build after installation.`);
  } else if (stale.length > 0) {
    console.log(`Deferring products build; workspace build outputs older than their sources: ${stale.join(', ')}. Run pnpm build after installation.`);
  } else {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: packageDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.status;
  }
}
