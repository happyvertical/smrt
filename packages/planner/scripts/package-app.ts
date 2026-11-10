/**
 * Build the static planner app for the package: `app/` is a copy of the
 * prerendered output with the default (empty) base. SvelteKit writes relative
 * asset URLs and works the base out in the browser, so the same files serve at
 * `/` and at any sub-path. A `BASE_PATH` in the environment would bake an
 * absolute base into `404.html`, so it is removed for this build.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';

const env = { ...process.env };
delete env.BASE_PATH;
const build = spawnSync('pnpm', ['exec', 'vite', 'build'], {
  stdio: 'inherit',
  env,
});
if (build.status !== 0) {
  console.error('vite build failed; app/ was not updated.');
  process.exit(build.status ?? 1);
}
if (!existsSync('build/index.html')) {
  console.error('vite build produced no build/index.html.');
  process.exit(1);
}
rmSync('app', { recursive: true, force: true });
cpSync('build', 'app', { recursive: true });
console.log('app/ ready');
