const {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} = require('node:fs');
const { join, resolve } = require('node:path');

// The stable, ignored symlink keeps machine-specific paths out of the lockfile.
function configureLocalSmrt(config, projectRoot, smrtRoot) {
  if (!smrtRoot) return config;
  const root = resolve(smrtRoot);
  if (!existsSync(join(root, 'packages/core/package.json'))) {
    throw new Error(
      'SMRT_ROOT must point to the happyvertical/smrt repository root.',
    );
  }
  const link = join(projectRoot, '.smrt-local');
  try {
    if (!lstatSync(link).isSymbolicLink())
      throw new Error('.smrt-local must be a symlink.');
    try {
      if (realpathSync(link) !== realpathSync(root)) unlinkSync(link);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      unlinkSync(link);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!existsSync(link)) symlinkSync(root, link, 'dir');
  const overrides = { ...config.overrides };
  for (const entry of readdirSync(join(root, 'packages')).sort()) {
    const file = join(root, 'packages', entry, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (pkg.name?.startsWith('@happyvertical/smrt-')) {
      overrides[pkg.name] = `link:.smrt-local/packages/${entry}`;
    }
  }
  return { ...config, overrides };
}

module.exports = { configureLocalSmrt };
