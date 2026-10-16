import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * `./core` must run in plain Node: packaged by svelte-package (as `pnpm
 * package` does) and imported by a bare `node` process, with no Vite and no
 * Svelte compiler. Its published dependencies resolve as they do after an
 * install: `node_modules` is linked beside the output, nothing else is.
 */
const root = resolve(import.meta.dirname, '..');
let out = '';

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'planner-core-'));
  execFileSync(
    'pnpm',
    [
      'exec',
      'svelte-package',
      '-i',
      'src/lib',
      '-o',
      out,
      '--tsconfig',
      'tsconfig.package.json',
    ],
    { cwd: root, stdio: 'pipe' },
  );
  // After packaging, which clears the directory.
  symlinkSync(join(root, 'node_modules'), join(out, 'node_modules'), 'dir');
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

it('maps ./core and ./app in the package exports', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(pkg.exports['./core'].default).toBe('./dist/core/index.js');
  expect(pkg.exports['./app'].default).toBe('./dist/core/app.js');
  expect(pkg.exports['./app/*']).toBe('./app/*');
  expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'app']));
});

it('imports and runs under plain Node', () => {
  const entry = pathToFileURL(join(out, 'core', 'index.js')).href;
  const script = `
    const core = await import(${JSON.stringify(entry)});
    const snapshot = {
      version: 1, revision: 1, app: { name: 'my-app', cookbook: null },
      recipes: [], features: [], unavailable: [],
      settings: { currency: 'USD', taxRate: 0, paymentTerms: '' },
      theme: { text: 'smrt', preset: null, primary: null, colorScheme: 'system' },
      sections: [], focus: { tab: null, section: null }, policies: 0, undo: [],
    };
    const prompt = core.buildHostPrompt({ message: 'I run a bakery', snapshot });
    const parsed = core.parseHostReply('{"reply":"ok","add":["commerce.invoicing"]}');
    console.log(JSON.stringify({
      tools: core.commandTools.length,
      schemas: Object.keys(core.commandSchemas).length,
      recipes: core.recipes.length,
      cookbooks: core.libraryCookbooks.length,
      system: prompt.system.includes('You help assemble a small business app'),
      last: prompt.messages.at(-1),
      add: parsed.reply.add,
      schema: core.replySchema.type,
    }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: out, encoding: 'utf8' },
  );
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
  expect(result.tools).toBe(21);
  expect(result.schemas).toBe(21);
  expect(result.recipes).toBeGreaterThan(10);
  expect(result.cookbooks).toBeGreaterThan(0);
  expect(result.system).toBe(true);
  expect(result.last).toEqual({ role: 'user', content: 'I run a bakery' });
  expect(result.add).toEqual(['commerce.invoicing']);
  expect(result.schema).toBe('object');
});

it('runs the headless planner under plain Node', () => {
  const entry = pathToFileURL(join(out, 'core', 'index.js')).href;
  const script = `
    const core = await import(${JSON.stringify(entry)});
    const a = core.createHeadlessPlanner();
    const b = core.createHeadlessPlanner();
    const added = a.run({ name: 'add_cookbook', input: { id: 'bakery' } });
    const bad = a.run({ name: 'add_recipes', input: { ids: ['nope'] } });
    const tax = a.run({ name: 'set_settings', input: { taxRate: 13 } });
    const undone = a.undo();
    const exported = a.run({ name: 'export_cookbook', input: {} });
    console.log(JSON.stringify({
      added: added.ok && added.receipt.changed,
      bad: bad.ok ? 'ok' : bad.error.code,
      tax: tax.ok && tax.snapshot.settings.taxRate,
      undone: undone.ok && undone.snapshot.settings.taxRate,
      recipes: a.snapshot().recipes.length,
      other: b.snapshot().recipes.length,
      doc: a.cookbook().recipes.length,
      file: exported.ok && exported.data.fileName,
      same: exported.ok && exported.data.text === JSON.stringify(a.cookbook(), null, 2) + '\\n',
    }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: out, encoding: 'utf8' },
  );
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
  expect(result.added).toBe(true);
  expect(result.bad).toBe('invalid_input');
  expect(result.tax).toBe(13);
  expect(result.undone).toBe(0);
  expect(result.recipes).toBeGreaterThan(0);
  expect(result.other).toBe(0);
  expect(result.doc).toBe(result.recipes);
  expect(result.file).toBe('my-app.cookbook.json');
  expect(result.same).toBe(true);
});

it('locates the packaged app directory', async () => {
  const mod = await import(pathToFileURL(join(out, 'core', 'app.js')).href);
  expect(mod.appDir.endsWith('/app/')).toBe(true);
  expect(mod.appFile('index.html').endsWith('/app/index.html')).toBe(true);
});
