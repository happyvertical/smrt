import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Runtime initialization records installation custody under the per-user
// state root (#4704). Keep every test file's state out of the real home.
const home = mkdtempSync(
  join(realpathSync(tmpdir()), 'smrt-app-runtime-home-'),
);
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
