import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  chunked,
  paxData,
  type TarEntrySpec,
  tarArchive,
  tarEntry,
  tarHeader,
} from '../testing/tar-fixtures.js';
import { NodeDistError, type NodeDistErrorCode } from './node-errors.js';
import { extractTarMember, extractTarMembers } from './tar-member.js';

const WANTED = 'node-v1.2.3-linux-x64/bin/node';
const request = { name: WANTED, maxBytes: 1024 };

function source(archive: Buffer, size = 700): AsyncIterable<Uint8Array> {
  return chunked(archive, size);
}

async function codeOf(promise: Promise<unknown>): Promise<NodeDistErrorCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NodeDistError);
    return (error as NodeDistError).code;
  }
  throw new Error('expected rejection');
}

const good: TarEntrySpec = { name: WANTED, data: 'NODE-BINARY' };

describe('tar-member', () => {
  it('extracts only the named member and writes nothing else', async () => {
    const archive = tarArchive([
      { name: 'node-v1.2.3-linux-x64/', type: '5' },
      { name: 'node-v1.2.3-linux-x64/LICENSE', data: 'license' },
      good,
      { name: 'node-v1.2.3-linux-x64/README.md', data: 'readme' },
    ]);
    const data = await extractTarMember(source(archive), request);
    expect(data.toString()).toBe('NODE-BINARY');
  });

  it('extracts several members in one pass and returns exactly those', async () => {
    const archive = tarArchive([
      { name: 'dir/LICENSE', data: 'L' },
      good,
      { name: 'dir/other', data: 'x' },
    ]);
    const members = await extractTarMembers(source(archive), [
      request,
      { name: 'dir/LICENSE', maxBytes: 10 },
    ]);
    expect([...members.keys()].sort()).toEqual(['dir/LICENSE', WANTED]);
    expect(members.get('dir/LICENSE')?.toString()).toBe('L');
  });

  it('handles tiny and huge source chunking identically', async () => {
    const archive = tarArchive([good]);
    for (const size of [1, 7, 511, 512, 513, archive.length]) {
      const data = await extractTarMember(source(archive, size), request);
      expect(data.toString()).toBe('NODE-BINARY');
    }
  });

  it('ignores ../ and absolute member names (they never match)', async () => {
    const archive = tarArchive([
      { name: `../${WANTED}`, data: 'evil' },
      { name: `/${WANTED}`, data: 'evil' },
      { name: `./${WANTED}`, data: 'evil' },
      { name: `x/../${WANTED}`, data: 'evil' },
      { name: '../../etc/passwd', data: 'evil' },
      good,
    ]);
    const data = await extractTarMember(source(archive), request);
    expect(data.toString()).toBe('NODE-BINARY');
  });

  it('reports a missing member when only traversal names are present', async () => {
    const archive = tarArchive([
      { name: `../${WANTED}`, data: 'evil' },
      { name: `/${WANTED}`, data: 'evil' },
    ]);
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'member_missing',
    );
  });

  it('rejects a symlink or hardlink member with the wanted name', async () => {
    for (const type of ['2', '1']) {
      const archive = tarArchive([
        { name: WANTED, type, linkName: '/etc/passwd' },
        good,
      ]);
      expect(await codeOf(extractTarMember(source(archive), request))).toBe(
        'member_unsafe',
      );
    }
  });

  it('rejects a directory, device or FIFO entry with the wanted name', async () => {
    for (const type of ['5', '3', '4', '6', '7', 'S']) {
      const archive = tarArchive([{ name: WANTED, type }]);
      expect(await codeOf(extractTarMember(source(archive), request))).toBe(
        'member_unsafe',
      );
    }
  });

  it('skips symlink members that merely point at the wanted name', async () => {
    const archive = tarArchive([
      { name: 'link-to-node', type: '2', linkName: WANTED },
      { name: 'hard-to-node', type: '1', linkName: WANTED },
      good,
    ]);
    const data = await extractTarMember(source(archive), request);
    expect(data.toString()).toBe('NODE-BINARY');
  });

  it('refuses the wanted name appearing twice', async () => {
    const archive = tarArchive([good, { name: WANTED, data: 'second' }]);
    // Both wanted names present: stop after the first would hide the second.
    const members = extractTarMember(source(archive), request);
    expect((await members).toString()).toBe('NODE-BINARY');
    const both = tarArchive([good, { name: WANTED, data: 'second' }]);
    expect(
      await codeOf(
        extractTarMembers(source(both), [
          request,
          { name: 'later', maxBytes: 5 },
        ]),
      ),
    ).toBe('member_ambiguous');
  });

  it('rejects a header with a bad checksum', async () => {
    const archive = tarArchive([{ ...good, badChecksum: true }]);
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'archive_invalid',
    );
  });

  it('rejects a block that is not a ustar header', async () => {
    const archive = tarArchive([{ ...good, magic: 'none' }]);
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'archive_invalid',
    );
  });

  it('accepts GNU-style magic', async () => {
    const archive = tarArchive([{ ...good, magic: 'gnu' }]);
    expect((await extractTarMember(source(archive), request)).toString()).toBe(
      'NODE-BINARY',
    );
  });

  it('rejects non-octal size fields', async () => {
    const header = tarHeader({ name: WANTED, type: '0', size: 3 });
    header.write('12x4\0', 124, 'latin1');
    // re-checksum is not needed: the size check runs after, so fix checksum.
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    expect(
      await codeOf(
        extractTarMember(
          source(Buffer.concat([header, Buffer.alloc(1024)])),
          request,
        ),
      ),
    ).toBe('archive_invalid');
  });

  it('rejects a member bigger than its cap before reading its data', async () => {
    const archive = tarArchive([{ name: WANTED, data: Buffer.alloc(4096, 1) }]);
    expect(
      await codeOf(
        extractTarMember(source(archive), { name: WANTED, maxBytes: 100 }),
      ),
    ).toBe('member_too_large');
  });

  it('rejects a size-bomb header whose size field far exceeds the cap', async () => {
    const archive = tarArchive(
      [{ name: WANTED, data: 'tiny', headerSize: 0o777777777777 }],
      { terminate: false },
    );
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'member_too_large',
    );
  });

  it('stops skipping an unrelated huge entry at the archive cap', async () => {
    const archive = tarArchive(
      [{ name: 'huge', data: 'short', headerSize: 0o77777777777 }],
      { terminate: false },
    );
    let pulled = 0;
    const endless = (async function* () {
      yield archive;
      for (;;) {
        pulled += 64 * 1024;
        yield Buffer.alloc(64 * 1024, 1);
      }
    })();
    expect(
      await codeOf(
        extractTarMember(endless, request, { maxArchiveBytes: 1024 * 1024 }),
      ),
    ).toBe('archive_too_large');
    // The reader stops pulling right at the cap; it does not drain the stream.
    expect(pulled).toBeLessThanOrEqual(1024 * 1024);
  });

  it('detects truncation in the member data, header and padding', async () => {
    const archive = tarArchive([good]);
    // header 512 + data block 512 = 1024; cut inside data, and after header.
    for (const cut of [10, 512, 520, 1000]) {
      expect(
        await codeOf(
          extractTarMember(source(archive.subarray(0, cut)), request),
        ),
      ).toMatch(/^archive_truncated$/);
    }
  });

  it('detects a lying size field that claims more data than exists', async () => {
    const archive = tarArchive(
      [{ name: WANTED, data: 'short', headerSize: 900 }],
      { terminate: false },
    );
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'archive_truncated',
    );
  });

  it('treats an empty or all-zero archive as a missing member', async () => {
    expect(
      await codeOf(extractTarMember(source(Buffer.alloc(0)), request)),
    ).toBe('member_missing');
    expect(
      await codeOf(extractTarMember(source(Buffer.alloc(1024)), request)),
    ).toBe('member_missing');
  });

  it('honours a pax path record for the Node member', async () => {
    const longName = `node-v1.2.3-linux-x64/${'d'.repeat(120)}/bin/node`;
    const archive = tarArchive([
      { name: 'PaxShort', pax: { path: longName }, data: 'PAX-NODE' },
    ]);
    const data = await extractTarMember(source(archive), {
      name: longName,
      maxBytes: 100,
    });
    expect(data.toString()).toBe('PAX-NODE');
  });

  it('does not match the short header name when a pax path overrides it', async () => {
    const archive = tarArchive([
      { name: WANTED, pax: { path: 'elsewhere/bin/node' }, data: 'x' },
    ]);
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'member_missing',
    );
  });

  it('applies a pax path only to the next entry', async () => {
    const archive = tarArchive([
      { name: 'a', pax: { path: 'renamed' }, data: 'x' },
      { name: WANTED, data: 'REAL' },
    ]);
    expect((await extractTarMember(source(archive), request)).toString()).toBe(
      'REAL',
    );
  });

  it('honours a pax size record that overrides a zero header size', async () => {
    const archive = tarArchive([
      { name: WANTED, pax: { size: '5' }, headerSize: 0, data: 'abcde' },
    ]);
    expect((await extractTarMember(source(archive), request)).toString()).toBe(
      'abcde',
    );
  });

  it('rejects malformed pax records', async () => {
    const badRecords: Buffer[] = [
      Buffer.from('999 path=x\n'),
      Buffer.from('12 path=x'),
      Buffer.from('abc path=x\n'),
      Buffer.from('7 pathx\n'),
    ];
    for (const body of badRecords) {
      const entry = Buffer.concat([
        tarHeader({ name: 'PaxHeader', type: 'x', size: body.length }),
        Buffer.concat([body, Buffer.alloc(512 - body.length)]),
        tarEntry(good),
        Buffer.alloc(1024),
      ]);
      expect(await codeOf(extractTarMember(source(entry), request))).toBe(
        'archive_invalid',
      );
    }
  });

  it('refuses a global pax header that sets path or size', async () => {
    for (const records of [{ path: 'x' }, { size: '3' }, { linkpath: 'y' }]) {
      const body = paxData(records);
      const archive = Buffer.concat([
        tarHeader({ name: 'g', type: 'g', size: body.length }),
        Buffer.concat([body, Buffer.alloc(512 - body.length)]),
        tarEntry(good),
        Buffer.alloc(1024),
      ]);
      expect(await codeOf(extractTarMember(source(archive), request))).toBe(
        'archive_invalid',
      );
    }
  });

  it('ignores a harmless global pax header', async () => {
    const body = paxData({ comment: 'hello' });
    const archive = Buffer.concat([
      tarHeader({ name: 'g', type: 'g', size: body.length }),
      Buffer.concat([body, Buffer.alloc(512 - body.length)]),
      tarEntry(good),
      Buffer.alloc(1024),
    ]);
    expect((await extractTarMember(source(archive), request)).toString()).toBe(
      'NODE-BINARY',
    );
  });

  it('honours a GNU long name for the Node member', async () => {
    const longName = `node-v1.2.3-linux-x64/${'e'.repeat(150)}/bin/node`;
    const archive = tarArchive([
      { name: 'truncated-name', gnuLongName: longName, data: 'GNU-NODE' },
    ]);
    const data = await extractTarMember(source(archive), {
      name: longName,
      maxBytes: 100,
    });
    expect(data.toString()).toBe('GNU-NODE');
  });

  it('joins the ustar prefix and name fields', async () => {
    const archive = tarArchive([
      { name: 'bin/node', prefix: 'node-v1.2.3-linux-x64', data: 'PRE' },
    ]);
    expect((await extractTarMember(source(archive), request)).toString()).toBe(
      'PRE',
    );
  });

  it('rejects member names containing NUL after pax decoding', async () => {
    const body = Buffer.from('18 path=ab\0cd/node\n');
    const archive = Buffer.concat([
      tarHeader({ name: 'p', type: 'x', size: body.length }),
      Buffer.concat([body, Buffer.alloc(512 - body.length)]),
      tarEntry(good),
      Buffer.alloc(1024),
    ]);
    expect(await codeOf(extractTarMember(source(archive), request))).toBe(
      'archive_invalid',
    );
  });

  it('maps stream errors to fixed codes without leaking the cause', async () => {
    const failing = (async function* () {
      yield tarEntry(good).subarray(0, 100);
      throw Object.assign(new Error('/secret/path boom'), {
        code: 'Z_DATA_ERROR',
      });
    })();
    try {
      await extractTarMember(failing, request);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as NodeDistError).code).toBe('archive_invalid');
      expect((error as Error).message).not.toContain('secret');
    }
    const eof = (async function* () {
      yield tarEntry(good).subarray(0, 100);
      throw Object.assign(new Error('unexpected end of file'), {
        code: 'Z_BUF_ERROR',
      });
    })();
    expect(await codeOf(extractTarMember(eof, request))).toBe(
      'archive_truncated',
    );
  });

  it('closes the source once all members are found', async () => {
    let closed = false;
    const archive = tarArchive([good]);
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        const inner = chunked(archive, 600);
        return {
          next: () => inner.next(),
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await extractTarMember(iterable, request);
    expect(closed).toBe(true);
  });

  it('round-trips through real gzip', async () => {
    const { gzipSync, createGunzip } = await import('node:zlib');
    const { Readable } = await import('node:stream');
    const archive = tarArchive([good]);
    expect(gunzipSync(gzipSync(archive)).length).toBe(archive.length);
    const gunzip = createGunzip();
    Readable.from([gzipSync(archive)]).pipe(gunzip);
    expect((await extractTarMember(gunzip, request)).toString()).toBe(
      'NODE-BINARY',
    );
  });

  it('rejects invalid requests', async () => {
    expect(
      await codeOf(
        extractTarMembers(source(tarArchive([good])), [
          request,
          { ...request },
        ]),
      ),
    ).toBe('archive_invalid');
  });
});
