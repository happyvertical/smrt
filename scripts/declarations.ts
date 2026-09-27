import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/** Emit source-shaped declarations with the workspace's standard tsc CLI. */
export function declarations(options: {
  packageDir: string;
  tsconfigPath?: string;
  outDir?: string;
  entries?: Record<string, string>;
  include?: string[];
  exclude?: string[];
}): Plugin {
  return {
    name: 'smrt-declarations',
    apply: 'build',
    closeBundle() {
      const temporaryDir = mkdtempSync(
        resolve(options.packageDir, '.smrt-declarations-'),
      );
      const configPath = resolve(temporaryDir, 'tsconfig.json');
      const absolute = (pattern: string) =>
        resolve(options.packageDir, pattern);
      try {
        writeFileSync(
          configPath,
          JSON.stringify({
            extends: options.tsconfigPath ?? absolute('tsconfig.json'),
            compilerOptions: {
              rootDir: absolute('src'),
              outDir: absolute(options.outDir ?? 'dist'),
              declarationDir: absolute(options.outDir ?? 'dist'),
              declaration: true,
              declarationMap: true,
              emitDeclarationOnly: true,
              noEmit: false,
              noEmitOnError: true,
              composite: false,
              incremental: false,
              // Resolve dependencies through their public built exports. Source
              // aliases neither rewrite imports nor define published contracts.
              paths: {},
            },
            include: (options.include ?? ['src/**/*.ts', 'ambient.d.ts']).map(
              absolute,
            ),
            exclude: (options.exclude ?? ['**/*.test.ts', '**/*.spec.ts']).map(
              absolute,
            ),
            references: [],
          }),
        );
        const result = spawnSync(
          process.execPath,
          [require.resolve('typescript/bin/tsc'), '--project', configPath],
          { cwd: options.packageDir, stdio: 'inherit' },
        );
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(
            `Declaration generation failed for ${options.packageDir} (exit ${result.status})`,
          );
        }
        for (const [name, source] of Object.entries(options.entries ?? {})) {
          const sourcePath = relative(absolute('src'), source).replace(
            /\.[cm]?tsx?$/,
            '.js',
          );
          const entryPath = absolute(
            `${options.outDir ?? 'dist'}/${name}.d.ts`,
          );
          const sourceOutput = absolute(
            `${options.outDir ?? 'dist'}/${sourcePath}`,
          );
          if (entryPath.replace(/\.d\.ts$/, '.js') === sourceOutput) continue;
          let specifier = relative(dirname(entryPath), sourceOutput).replace(
            /\\/g,
            '/',
          );
          if (!specifier.startsWith('.')) specifier = `./${specifier}`;
          mkdirSync(dirname(entryPath), { recursive: true });
          writeFileSync(entryPath, `export * from '${specifier}';\n`);
        }
      } finally {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    },
  };
}
