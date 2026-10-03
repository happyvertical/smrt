/**
 * The plugin registers generated objects before the app's server config
 * module runs (#3416), so the app no longer hand-writes the guarded
 * `smrt-register.js` import.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { smrtPlugin } from './index.js';
import { injectSvelteKitRegistration } from './sveltekit-register-injection.js';

const SOURCE = "export const runtime = 'app';\n";

describe('injectSvelteKitRegistration', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-register-injection-'));
    mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeRegistration(dir = 'src/lib/server'): void {
    mkdirSync(join(projectRoot, dir), { recursive: true });
    writeFileSync(join(projectRoot, dir, 'smrt-register.ts'), '');
  }

  it('prepends the generated registration to the default config module', () => {
    writeRegistration();
    const id = join(projectRoot, 'src/lib/server/smrt.ts');
    const code = injectSvelteKitRegistration(SOURCE, id, { projectRoot });
    expect(code).toBe(`import './smrt-register.js';${SOURCE}`);
    // Same line: later line numbers are unchanged.
    expect(code?.split('\n')).toHaveLength(SOURCE.split('\n').length);
    // Query suffixes Vite appends still identify the module.
    expect(
      injectSvelteKitRegistration(SOURCE, `${id}?v=123`, { projectRoot }),
    ).toBe(code);
  });

  it('honours a custom config path and file name', () => {
    writeRegistration('src/server');
    const options = {
      projectRoot,
      configPath: 'src/server',
      configFileName: 'app-smrt.ts',
    };
    expect(
      injectSvelteKitRegistration(
        SOURCE,
        join(projectRoot, 'src/server/app-smrt.ts'),
        options,
      ),
    ).toBe(`import './smrt-register.js';${SOURCE}`);
    expect(
      injectSvelteKitRegistration(
        SOURCE,
        join(projectRoot, 'src/lib/server/smrt.ts'),
        options,
      ),
    ).toBeNull();
  });

  it('leaves every other module untouched', () => {
    writeRegistration();
    for (const id of [
      join(projectRoot, 'src/lib/server/smrt-register.ts'),
      join(projectRoot, 'src/lib/server/other.ts'),
      join(projectRoot, 'src/hooks.server.ts'),
      join(projectRoot, 'node_modules/x/src/lib/server/smrt.ts'),
    ]) {
      expect(injectSvelteKitRegistration(SOURCE, id, { projectRoot })).toBe(
        null,
      );
    }
  });

  it('does not inject before the registration module is generated', () => {
    expect(
      injectSvelteKitRegistration(
        SOURCE,
        join(projectRoot, 'src/lib/server/smrt.ts'),
        { projectRoot },
      ),
    ).toBeNull();
  });
});

describe('smrtPlugin transform: SvelteKit registration', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-register-plugin-'));
    mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/lib/server/smrt-register.ts'), '');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  type TransformHook = (
    code: string,
    id: string,
  ) => { code: string; map: null } | null;

  it('injects only when SvelteKit generation is enabled', () => {
    const id = join(projectRoot, 'src/lib/server/smrt.ts');
    const enabled = smrtPlugin({
      projectRoot,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      },
    });
    const disabled = smrtPlugin({ projectRoot });
    expect((enabled.transform as TransformHook)(SOURCE, id)).toEqual({
      code: `import './smrt-register.js';${SOURCE}`,
      map: null,
    });
    expect((disabled.transform as TransformHook)(SOURCE, id)).toBeNull();
  });
});
