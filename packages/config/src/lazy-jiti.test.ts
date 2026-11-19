import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// jiti is a TypeScript transpiler needed only for smrt.config.{ts,mts,cts}. A
// process that never loads one must not pay for it (#5215). Each case runs in
// a fresh child process so module state is genuinely clean.
const here = dirname(fileURLToPath(import.meta.url));
const loaderUrl = new URL('./loader.ts', import.meta.url).href;
const tsxEntry = join(here, '../../../node_modules/tsx/dist/loader.mjs');

const childScript = `
import { registerHooks } from 'node:module';
const jitiSpecifiers = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (/[\\\\/]jiti[\\\\/]/.test(result.url) || specifier === 'jiti') {
      jitiSpecifiers.push(specifier);
    }
    return result;
  },
});
const { loadConfig } = await import(${JSON.stringify(loaderUrl)});
const config = await loadConfig({
  configPath: process.env.CONFIG_PATH,
  cache: false,
});
console.log(JSON.stringify({ config, jitiLoaded: jitiSpecifiers.length > 0 }));
`;

function run(configPath: string, cwd: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL(`file://${tsxEntry}`).href,
      '--input-type=module',
      '--eval',
      childScript,
    ],
    {
      cwd,
      env: { ...process.env, CONFIG_PATH: configPath },
      encoding: 'utf-8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as {
    config: Record<string, unknown>;
    jitiLoaded: boolean;
  };
}

describe('jiti is loaded lazily (#5215)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-lazy-jiti-'));
    mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not load jiti for a JavaScript or JSON config', () => {
    const jsonPath = join(dir, 'smrt.config.json');
    writeFileSync(jsonPath, JSON.stringify({ smrt: { logLevel: 'warn' } }));
    const out = run(jsonPath, dir);
    expect(out.config).toMatchObject({ smrt: { logLevel: 'warn' } });
    expect(out.jitiLoaded).toBe(false);
  });

  it('loads jiti and transpiles a TypeScript config', () => {
    const tsPath = join(dir, 'smrt.config.ts');
    writeFileSync(
      tsPath,
      `interface C { smrt: { logLevel: string } }
       const config = { smrt: { logLevel: 'debug' } } satisfies C;
       export default config;`,
    );
    const out = run(tsPath, dir);
    expect(out.config).toMatchObject({ smrt: { logLevel: 'debug' } });
    expect(out.jitiLoaded).toBe(true);
  });
});
