/**
 * The catalog is generated from every workspace package that publishes a
 * manifest. Each of those must be a dependency of the planner: that is what
 * makes Turbo build its manifest before `catalog:generate` (`^build`), and
 * what makes the affected-package filter run these tests, library cookbook
 * validation included, on any pull request that changes one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const packages = new URL('../../', import.meta.url);
const read = (dir: string): PackageJson | undefined => {
  try {
    return JSON.parse(
      readFileSync(new URL(`${dir}/package.json`, packages), 'utf8'),
    ) as PackageJson;
  } catch {
    return undefined;
  }
};

it('depends on every workspace package the catalog reads', () => {
  const sources = readdirSync(packages)
    .map(read)
    .filter(
      (pkg): pkg is PackageJson & { name: string } =>
        !!pkg?.name?.startsWith('@happyvertical/smrt-') &&
        !pkg.private &&
        pkg.exports?.['./manifest.json'] !== undefined,
    )
    .map((pkg) => pkg.name)
    .sort();
  const planner = read('planner') as PackageJson;
  const declared = { ...planner.dependencies, ...planner.devDependencies };
  const missing = sources.filter((name) => declared[name] !== 'workspace:*');
  expect(sources.length).toBeGreaterThan(30);
  expect(missing, 'add each as a workspace:* devDependency').toEqual([]);
});
