import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codemodSource, main } from './codemod-same-name-subclass.mjs';

const header = "import { Customer as CustomerBase } from '@acme/commerce';\nimport { smrt } from '@happyvertical/smrt-core';\n";

test('adds the option to an empty, an inline and a multi-line @smrt()', () => {
  for (const [before, after] of [
    ['@smrt()', '@smrt({ replaceParent: true })'],
    ['@smrt({})', '@smrt({ replaceParent: true })'],
    ["@smrt({ api: true })", "@smrt({ replaceParent: true, api: true })"],
    ["@smrt({\n  tableName: 'customers',\n})", "@smrt({\n  replaceParent: true,\n  tableName: 'customers',\n})"],
  ]) {
    const source = `${header}\n${before}\nexport class Customer extends CustomerBase {}\n`;
    const result = codemodSource(source, true);
    assert.equal(result.source, `${header}\n${after}\nexport class Customer extends CustomerBase {}\n`);
    assert.deepEqual(result.findings, [
      { name: 'Customer', parent: '@acme/commerce:Customer', line: source.split('\n').indexOf('export class Customer extends CustomerBase {}') + 1, status: 'missing' },
    ]);
    // A second run finds the declaration and changes nothing.
    const again = codemodSource(result.source, true);
    assert.equal(again.source, result.source);
    assert.equal(again.findings[0].status, 'declared');
  }
});

test('reads the public name from an export alias or the name option', () => {
  const aliased = `${header}\n@OtherDecorator()\n@smrt({})\nexport class AppCustomer extends CustomerBase {}\nexport { AppCustomer as Customer };\n`;
  assert.match(codemodSource(aliased, true).source, /@smrt\(\{ replaceParent: true \}\)\nexport class AppCustomer/);
  const named = `${header}\n@smrt({ name: 'Customer' })\nclass AppCustomer extends CustomerBase {}\n`;
  assert.match(codemodSource(named, true).source, /@smrt\(\{ replaceParent: true, name: 'Customer' \}\)/);
});

test('reports without editing when asked only to check, and when there is no registration to edit', () => {
  const source = `${header}\n@smrt({})\nexport class Customer extends CustomerBase {}\n`;
  assert.equal(codemodSource(source).source, source);
  assert.equal(codemodSource(source).findings[0].status, 'missing');
  const bare = `${header}\nexport class Customer extends CustomerBase {}\n`;
  const result = codemodSource(bare, true);
  assert.equal(result.source, bare);
  assert.equal(result.findings[0].status, 'no-registration');
});

test('leaves other classes alone: another name, the same package, a namespace member of another name', () => {
  for (const source of [
    `${header}\n@smrt({})\nexport class VipCustomer extends CustomerBase {}\n`,
    "import { Customer as CustomerBase } from './customer';\n@smrt({})\nexport class Customer extends CustomerBase {}\n",
    "import * as commerce from '@acme/commerce';\n@smrt({})\nexport class Customer extends commerce.Account {}\n",
    "import { SmrtObject, smrt } from '@happyvertical/smrt-core';\n@smrt({})\nexport class Customer extends SmrtObject {}\n",
  ]) {
    const result = codemodSource(source, true);
    assert.equal(result.source, source);
    assert.deepEqual(result.findings, []);
  }
  const namespaced = "import * as commerce from '@acme/commerce';\n@smrt()\nexport class Customer extends commerce.Customer {}\n";
  assert.match(codemodSource(namespaced, true).source, /@smrt\(\{ replaceParent: true \}\)/);
});

test('edits the call form of a class expression and of a declaration, under any local name for smrt', () => {
  const expression = "import { smrt } from '@happyvertical/smrt-core';\nimport { Content as SmrtContent } from '@acme/content';\nexport const Content: typeof SmrtContent = class Content extends SmrtContent {};\nsmrt({ packageName: '@local/app' })(Content);\n";
  const edited = codemodSource(expression, true);
  assert.match(edited.source, /smrt\(\{ replaceParent: true, packageName: '@local\/app' \}\)\(Content\)/);
  assert.equal(edited.findings[0].status, 'missing');
  const renamed = "import { smrt as model } from '@happyvertical/smrt-core';\nimport { Customer as CustomerBase } from '@acme/commerce';\n@model()\nexport class Customer extends CustomerBase {}\nclass Profile extends ProfileBase {}\n";
  assert.match(codemodSource(renamed, true).source, /@model\(\{ replaceParent: true \}\)/);
  const declaration = "import { smrt } from '@happyvertical/smrt-core';\nimport { Person as SmrtPerson } from '@acme/profiles';\nexport function register() {\n  class Person extends SmrtPerson {}\n  smrt({})(Person);\n}\n";
  assert.match(codemodSource(declaration, true).source, /smrt\(\{ replaceParent: true \}\)\(Person\)/);
});

test('follows a relative re-export to another package, and leaves a class of the same package alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemod-5143-'));
  try {
    writeFileSync(join(root, 'barrel.ts'), "export { Customer } from '@acme/commerce';\nexport * from './more';\n");
    writeFileSync(join(root, 'more.ts'), "export { Account as Account } from '@acme/ledger';\n");
    writeFileSync(join(root, 'local.ts'), "export class Invoice {}\n");
    const file = join(root, 'models.ts');
    const source = "import { smrt } from '@happyvertical/smrt-core';\nimport { Customer as Base, Account as AccountBase } from './barrel';\nimport { Invoice as InvoiceBase } from './local';\n@smrt()\nexport class Customer extends Base {}\n@smrt()\nexport class Account extends AccountBase {}\n@smrt()\nexport class Invoice extends InvoiceBase {}\n";
    const result = codemodSource(source, true, file);
    assert.deepEqual(
      result.findings.map(({ name, parent }) => [name, parent]),
      [['Customer', '@acme/commerce:Customer'], ['Account', '@acme/ledger:Account']],
    );
    assert.doesNotMatch(result.source, /replaceParent: true \}\)\nexport class Invoice/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the command exits non-zero while a class is undeclared, and zero once --write declared it', () => {
  const root = mkdtempSync(join(tmpdir(), 'codemod-5143-cli-'));
  const errors = console.error;
  const logs = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src', 'models.ts');
    writeFileSync(file, `${header}\n@smrt({})\nexport class Customer extends CustomerBase {}\nexport const Other = class Other extends Missing {};\n`);
    assert.equal(main([join(root, 'src')]), 1);
    assert.equal(main(['--write', join(root, 'src')]), 0);
    assert.match(readFileSync(file, 'utf8'), /@smrt\(\{ replaceParent: true \}\)/);
    assert.equal(main([join(root, 'src')]), 0);
    // A class with no registration in its file stays pending after --write.
    writeFileSync(file, `${header}\nexport class Customer extends CustomerBase {}\n`);
    assert.equal(main(['--write', join(root, 'src')]), 1);
  } finally {
    console.error = errors;
    console.log = logs;
    rmSync(root, { recursive: true, force: true });
  }
});

test('never edits source text in strings or templates, and reports it without failing', () => {
  const fixture = `import { smrt } from '@happyvertical/smrt-core';\nconst source = \`\n  import { Scene as SceneBase } from '@happyvertical/smrt-video';\n  @smrt()\n  export class Scene extends SceneBase {}\n\`;\nconst other = "import { Customer as CustomerBase } from '@acme/commerce'; @smrt() export class Customer extends CustomerBase {}";\nexport { source, other };\n`;
  const result = codemodSource(fixture, true);
  assert.equal(result.source, fixture);
  assert.deepEqual(
    result.findings.map(({ name, status }) => [name, status]),
    [['Scene', 'in-string']],
  );
  const root = mkdtempSync(join(tmpdir(), 'codemod-5143-strings-'));
  const errors = console.error;
  const logs = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const file = join(root, 'fixture.test.ts');
    writeFileSync(file, fixture);
    assert.equal(main(['--write', root]), 0);
    assert.equal(readFileSync(file, 'utf8'), fixture);
  } finally {
    console.error = errors;
    console.log = logs;
    rmSync(root, { recursive: true, force: true });
  }
});

test('binds a call-form registration to the declaration in its own block, and leaves an ambiguous one pending', () => {
  const twoScopes = `import { smrt } from '@happyvertical/smrt-core';\nimport { Scene as SceneBase } from '@acme/video';\nexport function first() {\n  class Scene extends SceneBase {}\n  smrt({ packageName: '@a/one' })(Scene);\n}\nexport function second() {\n  class Scene extends SceneBase {}\n  smrt({ packageName: '@a/two' })(Scene);\n}\n`;
  const edited = codemodSource(twoScopes, true);
  assert.match(edited.source, /smrt\(\{ replaceParent: true, packageName: '@a\/one' \}\)\(Scene\)/);
  assert.match(edited.source, /smrt\(\{ replaceParent: true, packageName: '@a\/two' \}\)\(Scene\)/);
  assert.deepEqual(edited.findings.map((f) => f.status), ['missing', 'missing']);
  const ambiguous = `import { smrt } from '@happyvertical/smrt-core';\nimport { Scene as SceneBase } from '@acme/video';\nclass Scene extends SceneBase {}\nsmrt({ packageName: '@a/one' })(Scene);\nsmrt({ packageName: '@a/two' })(Scene);\n`;
  const result = codemodSource(ambiguous, true);
  assert.equal(result.source, ambiguous);
  assert.equal(result.findings[0].status, 'ambiguous');
});

test('reads options as code: a comment, a string value or a nested object naming replaceParent does not declare it', () => {
  for (const options of [
    "{\n  // replaceParent: true is added below\n  api: true,\n}",
    "{ /* replaceParent: true */ api: true }",
    "{ description: 'replaceParent: true', api: true }",
    "{ api: { replaceParent: true } }",
  ]) {
    const source = `${header}\n@smrt(${options})\nexport class Customer extends CustomerBase {}\n`;
    const result = codemodSource(source, true);
    assert.equal(result.findings[0].status, 'missing', options);
    assert.match(result.source, /replaceParent: true,/, options);
    assert.equal(codemodSource(result.source, true).findings[0].status, 'declared', options);
  }
  // A comment naming another public name does not rename the class.
  const commented = `${header}\n@smrt({ /* name: 'Other' */ api: true })\nexport class Customer extends CustomerBase {}\n`;
  assert.equal(codemodSource(commented, true).findings[0].status, 'missing');
  for (const declared of ["{ 'replaceParent': true }", '{ api: true, replaceParent: true }']) {
    const source = `${header}\n@smrt(${declared})\nexport class Customer extends CustomerBase {}\n`;
    assert.equal(codemodSource(source, true).findings[0].status, 'declared', declared);
  }
});

test('treats shorthand as declared and options that are not one object literal as undecidable, exiting non-zero', () => {
  // Shorthand names the option: nothing to add, so --write leaves one key.
  for (const options of ['{ replaceParent }', '{ api: true, replaceParent, mcp: true }']) {
    const source = `${header}\n@smrt(${options})\nexport class Customer extends CustomerBase {}\n`;
    const result = codemodSource(source, true);
    assert.equal(result.findings[0].status, 'declared', options);
    assert.equal(result.source, source, options);
  }
  // A conditional, a variable, a call or a spread decides nothing from the text.
  for (const options of ['flag ? { replaceParent: true } : {}', 'options', 'build({ replaceParent: true })', '{ ...base }', '{ ...base, api: true }']) {
    const source = `${header}\n@smrt(${options})\nexport class Customer extends CustomerBase {}\n`;
    for (const choice of [undefined, true]) {
      const result = codemodSource(source, choice);
      assert.equal(result.findings[0].status, 'unsupported-options', options);
      assert.equal(result.source, source, options);
    }
  }
  // A spread after the key can override it; one before it cannot.
  for (const [options, status] of [
    ['{ replaceParent: true, ...options }', 'unsupported-options'],
    ['{ ...options, replaceParent: true }', 'declared'],
  ]) {
    const source = `${header}\n@smrt(${options})\nexport class Customer extends CustomerBase {}\n`;
    const result = codemodSource(source, true);
    assert.equal(result.findings[0].status, status, options);
    assert.equal(result.source, source, options);
  }
  const root = mkdtempSync(join(tmpdir(), 'codemod-5143-undecidable-'));
  const errors = console.error;
  const logs = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'models.ts'),
      `${header}\n@smrt(flag ? { replaceParent: true } : {})\nexport class Customer extends CustomerBase {}\n`,
    );
    assert.equal(main([join(root, 'src')]), 1);
    assert.equal(main(['--write', join(root, 'src')]), 1);
  } finally {
    console.error = errors;
    console.log = logs;
    rmSync(root, { recursive: true, force: true });
  }
});
