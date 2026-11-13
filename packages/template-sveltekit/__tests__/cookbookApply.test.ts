/** Real second-host proof: no listeners, containers, or provider calls. */
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
import {
  buildCookbookShell,
  loadCookbookApp,
} from '../../smrt-svelte/src/components/cookbook/server.js';
import { applyShellLayout } from '../../smrt-svelte/src/components/workspace/admin-shell/layout.js';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const boot = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
const output = process.stdout.write.bind(process.stdout);
console.log = console.info = console.warn = () => {};
const root = process.cwd();
const { Server } = await import(pathToFileURL(join(root, '.svelte-kit/output/server/index.js')).href);
const { manifest } = await import(pathToFileURL(join(root, '.svelte-kit/output/server/manifest-full.js')).href);
const server = new Server(manifest);
await server.init({ env: process.env });
const origin = 'http://127.0.0.1:4999';
const request = async (path, cookie, body) => {
  const response = await server.respond(new Request(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: cookie ? { cookie, origin, 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { getClientAddress: () => '127.0.0.1' });
  return response.status === 308
    ? request(new URL(response.headers.get('location'), origin).pathname, cookie)
    : response;
};
assert.equal((await request('/api/_runtime/health')).status, 200);
assert.equal((await request('/api/customers')).status, 404);
assert.equal((await request('/api/_runtime/owner-link?launch=wrong')).status, 403);
const claimed = await request('/api/_runtime/owner-link?launch=' + process.env.SMRT_DESKTOP_OWNER_LINK_SECRET);
assert.equal(claimed.status, 302);
const cookie = claimed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie);
// Exercise the scaffolded first-run mounts through Fresh and the selected template.
let onboarding = await (await request('/api/onboarding', cookie)).json();
const change = async (action, extra = {}) => {
  const response = await request('/api/onboarding', cookie, { action, revision: onboarding.revision, ...extra });
  assert.equal(response.status, 200, action + ': ' + await response.clone().text());
  onboarding = await response.json();
};
const approve = async (requiresOwnerApproval = true) => {
  await change('apply');
  if (requiresOwnerApproval) {
  assert.equal(onboarding.approval.status, 'pending');
  const decision = await request('/api/assistant/approvals/' + onboarding.approvalId + '/decide', cookie, { approve: true });
  assert.equal(decision.status, 200);
  onboarding = await (await request('/api/onboarding', cookie)).json();
  } else {
    assert.equal(onboarding.approvalId, null, 'empty first run uses one confirmation');
    assert.equal(onboarding.approval, null);
  }
  assert.equal(onboarding.step, 'done');
  assert.equal(onboarding.completed, true);
};
assert.equal(onboarding.step, 'welcome');
assert.equal((await request('/', cookie)).headers.get('location'), '/onboarding');
assert.equal((await request('/onboarding', cookie)).status, 200);
await change('welcome');
assert.equal(onboarding.step, 'ai');
await change('skip');
assert.equal(onboarding.step, 'template');
await change('preview', { id: 'fresh' });
assert.deepEqual(onboarding.preview.after, []);
await approve(false);
assert.equal((await request('/', cookie)).status, 200, 'Fresh home');
assert.equal((await request('/api/customers', cookie)).status, 404, 'Fresh closes installed routes');
await change('restart');
await change('preview', { id: process.env.SMRT_TEST_COOKBOOK });
assert.ok(onboarding.preview.after.length);
assert.ok(onboarding.preview.after.every(label => !/Profile/.test(label)));
await approve();
const customer = await request('/api/customers', cookie, { name: 'Maya Second Host', email: 'maya@example.test', phone: '555-0101' });
assert.equal(customer.status, 201, await customer.clone().text());
assert.ok(JSON.stringify(await (await request('/api/customers', cookie)).json()).includes('Maya Second Host'));
assert.equal((await request('/api/customers', cookie)).status, 200);
// Identity is live/migrated for framework operations, but has no person-facing page.
for (const collection of ['profiles', 'profiletypes'])
  assert.equal((await request('/api/' + collection, cookie)).status, 200, collection);
for (const model of ['Profile', 'ProfileType'])
  assert.equal((await request('/m/profiles/' + model, cookie)).status, 404, model);
assert.match(await (await request('/s/section-people', cookie)).text(), /<h1[^>]*>Section not found<[/]h1>/);
// Installed Commerce includes Leases in the AOT superset; this cookbook did not enable it.
assert.equal((await request('/api/leases', cookie)).status, 404);
const expected = JSON.parse(readFileSync(join(root, '.smrt/navigation-proof.json'), 'utf8'));
for (const entry of expected.entries) {
  const screen = await request(entry.path, cookie);
  assert.equal(screen.status, 200, entry.path);
  const body = await screen.text();
  const title = body.match(/<title>([^<]*)<[/]title>/)?.[1];
  assert.equal(title, entry.label, entry.path);
  // SSR uses the actual generated web definition and shared screen column derivation.
  if (entry.path.includes('/commerce/Customer')) {
    const headings = [...body.matchAll(/<th(?:\\s[^>]*)?>([^]*?)<[/]th>/g)].map(match => match[1].replace(/<[^>]*>/g, '').replace(/[↕↑↓]/g, '').trim());
    assert.ok(headings.includes('Name'), JSON.stringify(headings));
    assert.ok(headings.includes('Status'), JSON.stringify(headings));
    assert.ok(!headings.some(label => /Profile|hash|json|authority|provenance|journal|backend|external/i.test(label)), JSON.stringify(headings));
  }
  assert.ok(!/Profile/.test(title), title);
  assert.ok(!expected.rawNames.includes(title), title);
}

for (const path of ['/settings', '/settings/inference', '/m/commerce/Customer'])
  assert.equal((await request(path, cookie)).status, 200, path);
const home = await request('/', cookie);
assert.equal(home.status, 303);
const page = await request(home.headers.get('location'), cookie);
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(!/href="[/]m[/]profiles[/]Profile/.test(html), 'no identity shortcut or sidebar entry');
const modelLinks = [...html.matchAll(/href="([/]m[/][^"?#]+)"[^>]*>([^]*?)<[/]a>/g)];
for (const link of modelLinks) {
  const entry = expected.entries.find(entry => entry.path.replace(/[/]$/, '') === link[1].replace(/[/]$/, ''));
  assert.ok(entry, 'every navigation entry comes from the cookbook: ' + link[1]);
}
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
      // Real pnpm resolves external tooling; every SMRT package uses the checkout.
      // Apply performs install and build itself, including subclass generation.
      const cliVersion = JSON.parse(
        readFileSync(join(repository, 'packages/cli/package.json'), 'utf8'),
      ).version;
      const oldRoot = process.env.SMRT_ROOT;
      process.env.SMRT_ROOT = repository;
      try {
        const result = applyCookbook({
          cookbook: report.cookbook,
          packages: report.packages,
          dir: root,
          cliVersion,
          installOutput: 'stderr',
        });
        expect(result.installed).toBe(true);
      } finally {
        if (oldRoot === undefined) delete process.env.SMRT_ROOT;
        else process.env.SMRT_ROOT = oldRoot;
      }
      for (const name of report.packages)
        expect(
          existsSync(join(root, 'node_modules', name, 'package.json')),
        ).toBe(true);
      const applied = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      );
      for (const name of Object.keys({
        ...applied.dependencies,
        ...applied.devDependencies,
      })) {
        if (name.startsWith('@happyvertical/smrt-'))
          expect(realpathSync(join(root, 'node_modules', name))).toMatch(
            `${realpathSync(repository)}/packages/`,
          );
      }
      const prepared = JSON.parse(
        readFileSync(join(root, '.smrt/host-options.json'), 'utf8'),
      );
      expect(prepared.expose).toContain('@happyvertical/smrt-profiles:Profile');
      expect(prepared.expose).toContain('@happyvertical/smrt-commerce:Lease');
      expect(prepared.generationSnapshot.path).toMatch(
        /^\.smrt\/host-snapshots\/[a-f0-9]{64}\.json$/,
      );
      expect(
        readFileSync(join(root, 'src/lib/objects/profiles/Profile.ts'), 'utf8'),
      ).toContain('class Profile extends ProfileBase');
      const app = await loadCookbookApp({ root });
      const shell = buildCookbookShell(app);
      const entries = [...shell.entries.values()];
      const labels = new Set([
        ...app.catalog.recipes.flatMap((recipe) =>
          recipe.nav.map((entry) => entry.label),
        ),
        ...Object.values(app.cookbook.layout?.items ?? {}).map(
          (item) => item.label,
        ),
      ]);
      const rawNames = app.catalog.models.map((model) => model.name);
      const sectionLabels = new Set([
        ...app.catalog.recipes.map(
          (recipe) =>
            recipe.section?.label ?? recipe.group?.label ?? recipe.label,
        ),
        ...Object.values(app.cookbook.layout?.sections ?? {}).map(
          (section) => section.label,
        ),
        ...(app.cookbook.layout?.customSections ?? []).map(
          (section) => section.label,
        ),
      ]);
      const visibleNav = applyShellLayout(
        [],
        shell.navGroups,
        undefined,
        shell.layout,
      );
      for (const section of visibleNav.groups) {
        expect(sectionLabels.has(section.heading), section.heading).toBe(true);
        expect(section.heading).not.toMatch(/Profile/);
        expect(rawNames).not.toContain(section.heading);
        for (const item of section.items)
          expect(labels.has(item.label), item.label).toBe(true);
      }

      for (const entry of entries) {
        expect(labels.has(entry.label), entry.label).toBe(true);
        expect(entry.label).not.toMatch(/Profile/);
        expect(rawNames).not.toContain(entry.label);
      }
      expect(
        shell.sections.some((section) => section.id === 'section:people'),
      ).toBe(false);
      writeFileSync(
        join(root, '.smrt/navigation-proof.json'),
        JSON.stringify({
          entries: entries.map((entry) => ({
            path: entry.path,
            label: entry.label,
          })),
          rawNames,
        }),
      );
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
            ['SMRT_TEST_COOKBOOK', name],
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
          cliVersion,
          install: false,
          dryRun: true,
        });
        expect(preview.plan.cookbookDiff.after.models).toEqual(
          customized.models,
        );
        process.env.SMRT_ROOT = repository;
        try {
          applyCookbook({
            cookbook: report.cookbook,
            packages: report.packages,
            dir: root,
            cliVersion,
            installOutput: 'stderr',
          });
        } finally {
          if (oldRoot === undefined) delete process.env.SMRT_ROOT;
          else process.env.SMRT_ROOT = oldRoot;
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
