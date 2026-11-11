/** Real, offline second-host proof: no listeners, containers, or provider calls. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyCookbook } from '../../cli/src/commands/cookbook/apply.js';
import { resolveRecipeIndex } from '../../cli/src/commands/cookbook/recipe-index.js';
import {
  parseForResolution,
  validateCookbookText,
} from '../../cli/src/commands/cookbook/validate.js';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const boot = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const output = process.stdout.write.bind(process.stdout);
console.log = console.info = console.warn = () => {};
const root = process.cwd();
const { Server } = await import(pathToFileURL(join(root, '.svelte-kit/output/server/index.js')).href);
const { manifest } = await import(pathToFileURL(join(root, '.svelte-kit/output/server/manifest-full.js')).href);
const server = new Server(manifest);
await server.init({ env: process.env });
const origin = 'http://127.0.0.1:4999';
const request = (path, cookie) => server.respond(new Request(origin + path, {
  headers: cookie ? { cookie, origin } : {},
}), { getClientAddress: () => '127.0.0.1' });
assert.equal((await request('/api/_runtime/health')).status, 200);
assert.equal((await request('/api/customers')).status, 404);
assert.equal((await request('/api/_runtime/owner-link?launch=wrong')).status, 403);
const claimed = await request('/api/_runtime/owner-link?launch=' + process.env.SMRT_DESKTOP_OWNER_LINK_SECRET);
assert.equal(claimed.status, 302);
const cookie = claimed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie);
assert.equal((await request('/api/customers', cookie)).status, 200);
for (const path of ['/settings', '/settings/inference', '/m/commerce/Customer'])
  assert.equal((await request(path, cookie)).status, 200, path);
const home = await request('/', cookie);
assert.equal(home.status, 303);
const page = await request(home.headers.get('location'), cookie);
assert.equal(page.status, 200);
const html = await page.text();
const sections = [...new Set([...html.matchAll(/href="(\\/s\\/[^"?#]+)"/g)].map(match => match[1]))].sort();
assert.ok(sections.length, 'cookbook sections must be rendered');
output(JSON.stringify({ sections }) + '\\n');
process.exit(0);
`;

describe('complete bundled cookbook hosts', () => {
  it.each([
    'bakery',
    'mechanic',
    'welder',
    'yoga-studio',
  ])('applies and boots a second %s host with signed-in sections and settings', async (name) => {
    const temp = realpathSync(
      mkdtempSync(join(tmpdir(), 'smrt-cookbook-host-')),
    );
    try {
      const text = readFileSync(
        join(
          repository,
          'packages/core/src/cookbook/__fixtures__',
          `${name}.cookbook.json`,
        ),
        'utf8',
      );
      const index = await resolveRecipeIndex(parseForResolution(text), {
        dir: repository,
        registry: false,
      });
      const report = validateCookbookText(text, index);
      expect(report.errors).toEqual([]);
      if (!report.cookbook) throw new Error('Fixture validation failed');
      const root = join(temp, `second-${name}`);
      // The installer is the real pnpm, using the populated offline store.
      // Apply performs install and build itself, including subclass generation.
      const oldRoot = process.env.SMRT_ROOT;
      const oldOffline = process.env.npm_config_offline;
      process.env.SMRT_ROOT = repository;
      process.env.npm_config_offline = 'true';
      try {
        const result = applyCookbook({
          cookbook: report.cookbook,
          packages: report.packages,
          dir: root,
          cliVersion: '0.60.16',
          installOutput: 'stderr',
        });
        expect(result.installed).toBe(true);
      } finally {
        if (oldRoot === undefined) delete process.env.SMRT_ROOT;
        else process.env.SMRT_ROOT = oldRoot;
        if (oldOffline === undefined) delete process.env.npm_config_offline;
        else process.env.npm_config_offline = oldOffline;
      }
      for (const name of report.packages)
        expect(
          existsSync(join(root, 'node_modules', name, 'package.json')),
        ).toBe(true);
      const prepared = JSON.parse(
        readFileSync(join(root, '.smrt/host-options.json'), 'utf8'),
      );
      expect(prepared.expose).toContain('@happyvertical/smrt-profiles:Profile');
      expect(prepared.generationSnapshot.path).toMatch(
        /^\.smrt\/host-snapshots\/[a-f0-9]{64}\.json$/,
      );
      expect(
        readFileSync(join(root, 'src/lib/objects/profiles/Profile.ts'), 'utf8'),
      ).toContain('class Profile extends ProfileBase');
      const bootFile = join(temp, 'boot.mjs');
      writeFileSync(bootFile, boot);
      const output = execFileSync(process.execPath, [bootFile], {
        cwd: root,
        timeout: 120_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...Object.fromEntries([
            ['SMRT_RUNTIME_PROFILE', 'local'],
            ['SMRT_DATA_DIR', join(temp, 'private-data')],
            [
              'SMRT_DESKTOP_OWNER_LINK_SECRET',
              'fixture-launch-secret-never-published',
            ],
            ['HOST', '127.0.0.1'],
            ['ORIGIN', 'http://127.0.0.1:4999'],
          ]),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = JSON.parse(output.trim().split('\n').at(-1) ?? '');
      expect(result.sections.length).toBeGreaterThan(0);
      process.stdout.write(`${name} sections: ${result.sections.join(', ')}\n`);
      if (name === 'bakery') {
        const modelFile = join(root, 'src/lib/objects/profiles/Profile.ts');
        const edited = readFileSync(modelFile, 'utf8')
          .replace('import { smrt }', 'import { field, smrt }')
          .replace(
            'extends ProfileBase {}',
            "extends ProfileBase { @field() nickname = ''; }",
          );
        writeFileSync(modelFile, edited);
        const configFile = join(root, 'smrt.cookbook.json');
        const customized = JSON.parse(readFileSync(configFile, 'utf8'));
        const pkg = JSON.parse(
          readFileSync(join(root, 'package.json'), 'utf8'),
        );
        customized.models = {
          version: 1,
          packageName: pkg.name,
          lists: Object.fromEntries([
            [
              'Notes',
              {
                label: 'Notes',
                icon: 'file-text',
                displayField: 'title',
                fields: { title: { type: 'text' } },
              },
            ],
          ]),
          fields: {},
        };
        customized.policies[0] = {
          ...customized.policies[0],
          label: 'My wording',
        };
        writeFileSync(configFile, `${JSON.stringify(customized, null, 2)}\n`);
        const preview = applyCookbook({
          cookbook: report.cookbook,
          packages: report.packages,
          dir: root,
          cliVersion: '0.60.16',
          install: false,
          dryRun: true,
        });
        expect(preview.plan.cookbookDiff.after.models).toEqual(
          customized.models,
        );
        process.env.SMRT_ROOT = repository;
        process.env.npm_config_offline = 'true';
        try {
          applyCookbook({
            cookbook: report.cookbook,
            packages: report.packages,
            dir: root,
            cliVersion: '0.60.16',
            installOutput: 'stderr',
          });
        } finally {
          if (oldRoot === undefined) delete process.env.SMRT_ROOT;
          else process.env.SMRT_ROOT = oldRoot;
          if (oldOffline === undefined) delete process.env.npm_config_offline;
          else process.env.npm_config_offline = oldOffline;
        }
        expect(readFileSync(modelFile, 'utf8')).toBe(edited);
        expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual(
          preview.plan.cookbookDiff.after,
        );
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 600_000);
});
