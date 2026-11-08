import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { FUTURE, SLOT_ID, thrown } from '../testing/credentials.js';
import { MemoryFs } from '../testing/memory-fs.js';
import {
  newSlotId,
  newSlotRecord,
  parseSlotRecord,
  readSlotRecord,
  type SlotRecordV1,
  serializeSlotRecord,
  writeSlotRecord,
} from './slot-record.js';

const exampleText = readFileSync(
  fileURLToPath(new URL('../../examples/mcp-slot.json', import.meta.url)),
  'utf8',
);

const valid: SlotRecordV1 = {
  version: 1,
  slotId: SLOT_ID,
  scopes: ['notes.read'],
  expiresAt: FUTURE,
  state: 'minted',
};

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return (error as DesktopContractError).code;
  }
  return undefined;
}

const opts = { platform: 'linux' as const, currentUid: 1000 };

describe('slot record', () => {
  it('parses the shared example fixture and round-trips it', () => {
    const record = parseSlotRecord(exampleText);
    expect(record.slotId).toBe(SLOT_ID);
    expect(record.state).toBe('minted');
    expect(serializeSlotRecord(record)).toBe(exampleText);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('holds no secret: the serialized record has exactly the closed keys', () => {
    expect(Object.keys(JSON.parse(serializeSlotRecord(valid)))).toEqual([
      'version',
      'slotId',
      'scopes',
      'expiresAt',
      'state',
    ]);
  });

  it('accepts a minted slot before the first commit (expiresAt null)', () => {
    const fresh = newSlotRecord(['notes.read']);
    expect(fresh.state).toBe('minted');
    expect(fresh.expiresAt).toBeNull();
    expect(parseSlotRecord(serializeSlotRecord(fresh))).toEqual(fresh);
  });

  it('generates lowercase UUIDv4 slot ids', () => {
    const id = newSlotId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newSlotId()).not.toBe(id);
  });

  it.each([
    ['slotId', { slotId: 'not-a-uuid' }],
    ['slotId upper case', { slotId: SLOT_ID.toUpperCase() }],
    ['slotId v1', { slotId: '2c70f518-b95a-145b-a75e-8126ae7c032a' }],
    ['scopes empty', { scopes: [] }],
    ['scopes duplicate', { scopes: ['a', 'a'] }],
    ['scopes non-string', { scopes: [1] }],
    ['scope with space', { scopes: ['a b'] }],
    ['expiresAt not UTC', { expiresAt: '2026-12-01T12:00:00+01:00' }],
    ['expiresAt number', { expiresAt: 1 }],
    ['state unknown', { state: 'active' }],
    ['state pending', { state: 'pending' }],
  ])('rejects an invalid %s', (_name, patch) => {
    expect(
      code(() => parseSlotRecord(JSON.stringify({ ...valid, ...patch }))),
    ).toBe('invalid_field');
  });

  it('closes the schema and the version', () => {
    expect(
      code(() => parseSlotRecord(JSON.stringify({ ...valid, token: 'x' }))),
    ).toBe('invalid_document');
    const { state: _state, ...missing } = valid;
    expect(code(() => parseSlotRecord(JSON.stringify(missing)))).toBe(
      'invalid_document',
    );
    expect(
      code(() => parseSlotRecord(JSON.stringify({ ...valid, version: 2 }))),
    ).toBe('unsupported_contract');
    expect(code(() => parseSlotRecord('[]'))).toBe('invalid_document');
    expect(code(() => parseSlotRecord('{'))).toBe('invalid_json');
    expect(
      code(() =>
        parseSlotRecord(
          '{"version":1,"version":1,"slotId":"x","scopes":[],"expiresAt":null,"state":"minted"}',
        ),
      ),
    ).toBe('duplicate_keys');
    expect(code(() => parseSlotRecord(undefined as unknown as string))).toBe(
      'invalid_json',
    );
  });

  describe('persistence (tmp, fsync, rename)', () => {
    const dir = '/s';
    const path = '/s/mcp-slot.json';

    it('persists the slot before the first request can be made', async () => {
      const fs = new MemoryFs().set(dir, 'dir', { mode: 0o700 });
      const record = newSlotRecord(['notes.read']);
      await writeSlotRecord(path, record, {
        fs,
        randomSuffix: () => 'r',
        ...opts,
      });
      expect(fs.log).toEqual([
        'open:/s/mcp-slot.json.r.tmp',
        'sync',
        'rename:/s/mcp-slot.json.r.tmp>/s/mcp-slot.json',
        'open:/s',
        'sync',
      ]);
      expect(fs.nodes.get(path)?.mode).toBe(0o600);
      expect(await readSlotRecord(path, { fs, ...opts })).toEqual(record);
    });

    it('reads a missing record as null', async () => {
      const fs = new MemoryFs().set(dir, 'dir', { mode: 0o700 });
      expect(await readSlotRecord(path, { fs, ...opts })).toBeNull();
    });

    it('T2: readSlotRecord rejects a foreign-owned, group-readable or symlinked record', async () => {
      const text = serializeSlotRecord(valid);
      const cases: Array<[string, Parameters<MemoryFs['set']>]> = [
        [
          'foreign uid',
          [path, 'file', { uid: 4242, mode: 0o600, content: text }],
        ],
        ['group readable', [path, 'file', { mode: 0o640, content: text }]],
        ['other readable', [path, 'file', { mode: 0o604, content: text }]],
        ['symlink', [path, 'symlink', { mode: 0o777, content: text }]],
        ['directory', [path, 'dir', { mode: 0o700 }]],
      ];
      for (const [, args] of cases) {
        const fs = new MemoryFs().set(dir, 'dir', { mode: 0o700 });
        fs.set(...args);
        const error = await thrown(() => readSlotRecord(path, { fs, ...opts }));
        expect(error).toBeInstanceOf(DesktopContractError);
        expect((error as DesktopContractError).code).toBe('credential_invalid');
      }
    });

    it('T9: a symlink swapped in for the record is never followed or repaired', async () => {
      const fs = new MemoryFs().set(dir, 'dir', { mode: 0o700 });
      fs.set(path, 'symlink', {
        mode: 0o777,
        content: serializeSlotRecord(valid),
      });
      const error = await thrown(() => readSlotRecord(path, { fs, ...opts }));
      expect((error as DesktopContractError).code).toBe('credential_invalid');
      // The reader only opened (O_NOFOLLOW refused) and wrote nothing.
      expect(fs.log.filter((entry) => entry !== `open:${path}`)).toEqual([]);
      expect(fs.nodes.get(path)?.kind).toBe('symlink');
    });

    it('maps a corrupt record to credential_invalid without echoing it', async () => {
      const fs = new MemoryFs().set(dir, 'dir', { mode: 0o700 });
      fs.set(path, 'file', {
        mode: 0o600,
        content: '{"version":1,"slotId":"SECRET-CONTENT"}',
      });
      const error = (await thrown(() =>
        readSlotRecord(path, { fs, ...opts }),
      )) as DesktopContractError;
      expect(error.code).toBe('credential_invalid');
      expect(`${error.message}${error.stack}`).not.toContain('SECRET-CONTENT');
    });

    it('maps a failed write to credential_unavailable', async () => {
      const fs = new MemoryFs().set(dir, 'dir', { mode: 0o700 });
      fs.failNextWriteWith = 'ENOSPC';
      const error = (await thrown(() =>
        writeSlotRecord(path, valid, { fs, randomSuffix: () => 'r', ...opts }),
      )) as DesktopContractError;
      expect(error.code).toBe('credential_unavailable');
    });
  });
});
