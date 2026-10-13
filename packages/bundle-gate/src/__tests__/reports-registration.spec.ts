/** Production bundles must retain report model ownership (#3525). */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const stateNames = [
  'SmrtReportRun',
  'SmrtReportWatermark',
  'SmrtReportLock',
  'SmrtReportSchedule',
];
const taskNames = ['SmrtReportRefreshTask', 'SmrtPrincipalReportRefreshTask'];

describe('reports production registration (#3525)', () => {
  it.each([
    ['', [...stateNames, ...taskNames, 'RuntimeReport']],
    ['/state', stateNames],
    ['/scheduler', taskNames],
  ] as const)('keeps provider identities when importing reports%s', async (subpath, names) => {
    const temp = await mkdtemp(path.join(tmpdir(), 'smrt-reports-bundle-'));
    try {
      await symlink(
        path.join(packageRoot, 'node_modules'),
        path.join(temp, 'node_modules'),
        'dir',
      );
      await writeFile(
        path.join(temp, 'package.json'),
        JSON.stringify({ name: '@test/reports-consumer', type: 'module' }),
      );
      const input = path.join(temp, 'entry.js');
      await writeFile(
        input,
        `
        import { ObjectRegistry } from '@happyvertical/smrt-core';
        import { ${names.join(', ')} } from '@happyvertical/smrt-reports${subpath}';
        const models = { ${names.join(', ')} };
        console.log('REPORT_IDENTITIES=' + JSON.stringify(Object.entries(models).map(([name, constructor]) => {
          const registered = ObjectRegistry.getClassByConstructor(constructor);
          return { name, packageName: registered?.packageName, qualifiedName: registered?.qualifiedName,
            hasSchema: Boolean(registered?.schema?.ddl),
            matches: ObjectRegistry.findClassesByName(name).filter(entry => entry.constructor === constructor).length,
            qualifiedMatches: ObjectRegistry.getClass('@happyvertical/smrt-reports:' + name)?.constructor === constructor };
        })));
      `,
      );
      const outDir = path.join(temp, 'dist');
      await build({
        configFile: false,
        logLevel: 'error',
        build: {
          ssr: input,
          outDir,
          minify: false,
          target: 'node24',
          rollupOptions: { output: { entryFileNames: 'entry.js' } },
        },
        ssr: {
          noExternal: true,
          external: [
            'better-sqlite3',
            'pg-native',
            'duckdb',
            '@duckdb/node-api',
            '@duckdb/node-bindings',
            'sharp',
            'bufferutil',
            'utf-8-validate',
          ],
        },
      });
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(outDir, 'entry.js')],
        { cwd: outDir, maxBuffer: 10 * 1024 * 1024 },
      );
      const result = stdout
        .split('\n')
        .find((line) => line.startsWith('REPORT_IDENTITIES='));
      if (!result)
        throw new Error(
          `Missing report identities in bundle output: ${stdout}`,
        );
      expect(JSON.parse(result.slice('REPORT_IDENTITIES='.length))).toEqual(
        names.map((name) => ({
          name,
          packageName: '@happyvertical/smrt-reports',
          qualifiedName: `@happyvertical/smrt-reports:${name}`,
          hasSchema: true,
          matches: 1,
          qualifiedMatches: true,
        })),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
