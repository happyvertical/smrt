/** Deterministic transport fixture, not a mail server/provider quality test.
 * Invoke with Node --experimental-test-module-mocks. Real released SDK parses
 * raw RFC822 and real EmailAccount produces the retained intake snapshot.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const [rawPath, outputPath] = process.argv.slice(2);
if (!rawPath || !outputPath)
  throw Error('Expected raw RFC822 and output paths');
const raw = readFileSync(rawPath);
const sdkRequire = createRequire(import.meta.resolve('@happyvertical/email'));
const calls = [];
class ImapFlow {
  async mailboxOpen() {
    return { exists: 1, uidValidity: 7 };
  }
  async connect() {}
  async logout() {}
  async search(_criteria, options) {
    assert.equal(options.uid, true);
    return [42];
  }
  async *fetch(range, query, options) {
    calls.push({ range, query, options });
    assert.equal(options.uid, true);
    const requested = Array.isArray(range)
      ? range.includes(42)
      : Number(range) === 42;
    if (requested) yield { uid: 42, source: raw, flags: new Set() };
  }
}
mock.module(pathToFileURL(sdkRequire.resolve('imapflow')).href, {
  namedExports: Object.fromEntries([[ImapFlow.name, ImapFlow]]),
});
const { getEmailClient } = await import('@happyvertical/email');
const direct = await getEmailClient({
  type: 'imap',
  host: 'fixture.invalid',
  port: 993,
  auth: { user: 'synthetic', pass: 'local-non-secret-fixture' },
});
await direct.connect();
const parsed = await direct.getMessage('42');
assert.equal(parsed.id, '42');
assert.ok(parsed.attachments?.[0]?.content?.byteLength);
await direct.disconnect();
await import('@happyvertical/smrt-messages/providers/email');
const { EmailAccount } = await import('@happyvertical/smrt-messages');
const account = new EmailAccount({
  id: '44444444-4444-4444-8444-444444444444',
  isActive: true,
  providerType: 'imap',
});
account.getConfiguration = () => ({ host: 'fixture.invalid', port: 993 });
account.getCredentials = async () => ({
  auth: { user: 'synthetic', pass: 'local-non-secret-fixture' },
});
const snapshot = await account.readIntakeMessage('42', 1000000, {
  folder: 'INBOX',
  uidValidity: 7,
  uid: '42',
});
assert.ok(calls.length > 0);
writeFileSync(
  outputPath,
  JSON.stringify({
    snapshot: {
      ...snapshot,
      attachments: snapshot.attachments.map((part) => ({
        ...part,
        bytes: Array.from(part.bytes),
      })),
    },
    transport: {
      kind: 'mocked-imapflow-real-sdk-parser',
      uid: 42,
      sequence: 1,
      calls,
    },
  }),
  { flag: 'wx', mode: 0o600 },
);
