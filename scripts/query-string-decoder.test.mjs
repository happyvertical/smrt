import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
// Resolve from the real installed parents, including their patched pnpm links;
// looking for version-named store folders can accidentally test stale packages.
for (const [version, consumer] of [
  ['6.14.1', 'intuit-oauth'],
  ['7.1.3', '@googlemaps/google-maps-services-js'],
]) {
  const parent = createRequire(
    realpathSync(
      join(root, 'node_modules/.pnpm/node_modules', consumer, 'package.json'),
    ),
  );
  const entry = parent.resolve('query-string');
  const query = parent('query-string');
  const fromQuery = createRequire(entry);
  test(`query-string ${version} calls the patched published ESM decoder through its actual parent`, () => {
    assert.equal(
      JSON.parse(readFileSync(join(dirname(entry), 'package.json'))).version,
      version,
    );
    const decoder = fromQuery.resolve('decode-uri-component');
    assert.equal(
      JSON.parse(readFileSync(join(dirname(decoder), 'package.json'))).version,
      '0.5.1',
    );
    assert.equal(typeof fromQuery('decode-uri-component').default, 'function');
    assert.deepEqual(
      {
        ...query.parse(
          'greeting=hello+world&unicode=%F0%9F%98%80&name=%C3%A5&repeat=one&repeat=two',
        ),
      },
      {
        greeting: 'hello world',
        unicode: '😀',
        name: 'å',
        repeat: ['one', 'two'],
      },
    );
    const input = { name: 'å', reserved: '?=&', repeat: ['one', 'two'] };
    assert.deepEqual({ ...query.parse(query.stringify(input)) }, input);
    assert.deepEqual(
      { ...query.parse('bad=%E0%A4%A&mixed=%C3%A5%FF&once=%25%34%31%FF') },
      {
        bad: '%E0%A4%A',
        mixed: 'å%FF',
        once: '%41%FF',
      },
    );
  });
  test(`query-string ${version} bounds hostile malformed UTF-8 decoding without rescanning output`, () => {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
      const assert=require('node:assert/strict');
      const query=require(${JSON.stringify(entry)});
      const malformed='%C0'.repeat(20000);
      assert.equal(query.parse('value='+malformed+'%C3%A5').value,malformed+'å');
      assert.equal(query.parse('value=%25%34%31%FF').value,'%41%FF');
    `,
      ],
      { timeout: 5000, stdio: 'pipe' },
    );
  });
}
