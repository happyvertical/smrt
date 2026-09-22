import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NPMJS_REGISTRY,
  normalizeRegistry,
  primaryRegistry,
  registryArgs,
} from './release-registry.mjs';

test('the primary defaults to npmjs so an unconfigured checkout is unchanged', () => {
  assert.equal(primaryRegistry({}), NPMJS_REGISTRY);
  assert.equal(primaryRegistry({ RELEASE_PRIMARY_REGISTRY: '' }), NPMJS_REGISTRY);
});

test('the primary comes from the environment, normalized to a trailing slash', () => {
  assert.equal(
    primaryRegistry({ RELEASE_PRIMARY_REGISTRY: 'https://npm.happyvertical.com' }),
    'https://npm.happyvertical.com/',
  );
});

test('every registry call carries the scope flag, not only --registry', () => {
  // The repo .npmrc maps @happyvertical to npmjs and npm lets that mapping
  // override --registry, so --registry alone would publish to npmjs.
  assert.deepEqual(registryArgs('https://npm.happyvertical.com'), [
    '--registry',
    'https://npm.happyvertical.com/',
    '--@happyvertical:registry=https://npm.happyvertical.com/',
  ]);
});

test('a registry must be https, except a loopback test registry', () => {
  assert.throws(() => normalizeRegistry('http://npm.happyvertical.com/'), /must be https/);
  assert.equal(normalizeRegistry('http://127.0.0.1:4873'), 'http://127.0.0.1:4873/');
  assert.throws(() => normalizeRegistry('not a url'), /Invalid registry URL/);
});

test('no refusal path echoes a credential from the input into a log', () => {
  for (const url of [
    'https://user:secret@', // unparseable
    'http://user:secret@npm.happyvertical.com/', // wrong protocol
    'https://user:secret@npm.happyvertical.com/', // credentials
  ]) {
    assert.throws(
      () => normalizeRegistry(url),
      (error) => !error.message.includes('secret') && !error.message.includes('user:'),
      url.replace('secret', '***'),
    );
  }
});

test('a registry URL cannot smuggle credentials, a query, or a fragment', () => {
  for (const url of [
    'https://user:secret@npm.happyvertical.com/',
    'https://npm.happyvertical.com/?x=1',
    'https://npm.happyvertical.com/#frag',
  ]) {
    assert.throws(() => normalizeRegistry(url), /must not carry credentials/);
  }
  // The refusal must not echo the credential back into a CI log.
  assert.throws(
    () => normalizeRegistry('https://user:secret@npm.happyvertical.com/'),
    (error) => !error.message.includes('secret'),
  );
});

test('the primary can only be one of the reviewed registry hosts', () => {
  // The publish token is written for and sent to this host, so an arbitrary
  // https URL from configuration must be refused, not normalized.
  assert.throws(
    () => primaryRegistry({ RELEASE_PRIMARY_REGISTRY: 'https://registry.evil.example/' }),
    /registry\.evil\.example, which is not an allowed release registry/,
  );
  assert.throws(
    () => primaryRegistry({ RELEASE_PRIMARY_REGISTRY: 'https://npm.happyvertical.com.evil.example/' }),
    /not an allowed release registry/,
  );
  assert.throws(
    () => primaryRegistry({ RELEASE_PRIMARY_REGISTRY: 'https://npm.happyvertical.com:8443/' }),
    /not an allowed release registry/,
  );
  assert.equal(
    primaryRegistry({ RELEASE_PRIMARY_REGISTRY: 'http://127.0.0.1:4873' }),
    'http://127.0.0.1:4873/',
  );
});
