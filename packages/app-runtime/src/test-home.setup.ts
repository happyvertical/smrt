import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

// Runtime initialization records installation custody under the per-user
// state root (#4704). Keep every test file's state out of the real home, and
// out of /tmp: the #3877 tests make /tmp read as untrusted (#4866).
const root = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(realpathSync(root), 'smrt-app-runtime-home-'));
const original = {
  HOME: process.env.HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};
process.env.HOME = home;
delete process.env.XDG_STATE_HOME;

afterAll(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
