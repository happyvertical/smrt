/**
 * The relay is blind: an operator with the admin token, the object store, the
 * database, and the logs can see sizes and dates but cannot recover plaintext,
 * and the relay never holds key material.
 *
 * The blob is built like an encrypted snapshot from #4797: a clear header
 * followed by length-prefixed SDK v1 vault envelopes, each sealed with the
 * account's user-held key and bound to account, device, and sequence.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  openVaultSnapshot,
  sealVaultSnapshot,
} from '@happyvertical/encryption/vault-snapshot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VAULT_RELAY_TABLES } from '../metadata-store.js';
import {
  adminRequest,
  createHarness,
  downloadSnapshot,
  type Harness,
  newDevice,
  registerDevice,
  type TestDevice,
  uploadSnapshot,
} from './helpers.js';

const MARKER = 'FAMILY-PHOTO-CAPTION: grandma at the lake, summer 1987';

/** Build an HVSF-like encrypted snapshot of `plaintext` in `chunks` envelopes. */
function encryptedSnapshot(
  plaintext: Uint8Array,
  key: Uint8Array,
  keyId: string,
  context: { accountId: string; deviceId: string; sequence: bigint },
  chunkSize: number,
): Uint8Array {
  const header = Buffer.alloc(16);
  header.write('HVSF', 0, 'ascii');
  header.writeUInt32BE(1, 4);
  header.writeBigUInt64BE(context.sequence, 8);
  const parts: Buffer[] = [header];
  for (let offset = 0; offset < plaintext.length; offset += chunkSize) {
    const envelope = sealVaultSnapshot(
      plaintext.subarray(offset, offset + chunkSize),
      { key, keyId, context },
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(envelope.length, 0);
    parts.push(length, Buffer.from(envelope));
  }
  return new Uint8Array(Buffer.concat(parts));
}

function openEncryptedSnapshot(
  blob: Uint8Array,
  key: Uint8Array,
  keyId: string,
  context: { accountId: string; deviceId: string; sequence: bigint },
): Uint8Array {
  const bytes = Buffer.from(blob);
  const out: Buffer[] = [];
  for (let offset = 16; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const envelope = bytes.subarray(offset + 4, offset + 4 + length);
    out.push(
      Buffer.from(
        openVaultSnapshot(envelope, {
          context,
          resolveKey: (id) => (id === keyId ? key : undefined),
        }),
      ),
    );
    offset += 4 + length;
  }
  return new Uint8Array(Buffer.concat(out));
}

async function filesUnder(root: string): Promise<Buffer> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const contents: Buffer[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      contents.push(Buffer.from(path), await readFile(path));
    }
  }
  return Buffer.concat(contents);
}

let h: Harness;
let device: TestDevice;

beforeEach(async () => {
  h = await createHarness({ entitled: ['acct-family'] });
  device = newDevice('acct-family', 'laptop-1');
  await registerDevice(h, device);
});

afterEach(async () => {
  await h.close();
});

describe('blind operator', () => {
  it('stores a real encrypted snapshot that no operator surface can read', async () => {
    const key = new Uint8Array(randomBytes(32));
    const keyId = randomBytes(16).toString('hex');
    const context = {
      accountId: 'acct-family',
      deviceId: 'laptop-1',
      sequence: 1n,
    };
    const plaintext = new TextEncoder().encode(
      `${MARKER}\n${'family archive payload '.repeat(400)}`,
    );
    const blob = encryptedSnapshot(plaintext, key, keyId, context, 2048);

    const commit = await uploadSnapshot(h, device, 1, blob, 4096);
    expect(commit.status).toBe(201);

    // The operator can see sizes and dates.
    const admin = await h.relay.handleAdmin(
      adminRequest('GET', '/admin/v1/accounts/acct-family'),
    );
    expect(admin.status).toBe(200);
    const view = (await admin.json()) as {
      snapshots: Array<{ byteSize: number; createdAt: string }>;
    };
    expect(view.snapshots[0].byteSize).toBe(blob.length);
    expect(Date.parse(view.snapshots[0].createdAt)).not.toBeNaN();

    // Gather everything an operator holds: the admin listing, a raw dump of
    // every relay table, every stored object, and every log line.
    const tableDump: unknown[] = [];
    for (const table of VAULT_RELAY_TABLES) {
      tableDump.push((await h.db.query(`SELECT * FROM ${table}`)).rows);
    }
    const operatorText = [
      JSON.stringify(view),
      JSON.stringify(tableDump),
      JSON.stringify(h.logger.lines),
    ].join('\n');
    const storage = await filesUnder(h.storeRoot);
    const everything = Buffer.concat([Buffer.from(operatorText), storage]);

    // No plaintext, in any common encoding.
    for (const needle of [
      Buffer.from(MARKER),
      Buffer.from(MARKER).toString('base64'),
      Buffer.from(MARKER).toString('hex'),
      'family archive payload',
    ]) {
      expect(everything.includes(needle)).toBe(false);
    }
    // No key material: the relay never received the key, raw or encoded.
    for (const needle of [
      Buffer.from(key),
      Buffer.from(key).toString('hex'),
      Buffer.from(key).toString('base64'),
      Buffer.from(key).toString('base64url'),
    ]) {
      expect(everything.includes(needle)).toBe(false);
    }
    // Storage holds the ciphertext verbatim and nothing derived from content.
    expect(storage.includes(Buffer.from(blob.subarray(0, 4096)))).toBe(true);
    // Logs never carry the account id itself, only its hash handle.
    expect(JSON.stringify(h.logger.lines)).not.toContain('acct-family');

    // The ciphertext the relay returns opens only with the user's key.
    const downloaded = await downloadSnapshot(h, device, 1);
    expect(Buffer.from(downloaded)).toEqual(Buffer.from(blob));
    expect(
      Buffer.from(openEncryptedSnapshot(downloaded, key, keyId, context)),
    ).toEqual(Buffer.from(plaintext));
    expect(() =>
      openEncryptedSnapshot(
        downloaded,
        new Uint8Array(randomBytes(32)),
        keyId,
        context,
      ),
    ).toThrow();
  });

  it('keeps no key material in its configuration or state', () => {
    const state = inspect(h.relay, { depth: 3 });
    // Only a hash of the admin token is retained, never the token itself.
    expect(state).not.toContain('test-admin-token');
    expect(Object.keys(h.relay.policy)).toEqual([
      'quota',
      'retention',
      'limits',
    ]);
  });
});
