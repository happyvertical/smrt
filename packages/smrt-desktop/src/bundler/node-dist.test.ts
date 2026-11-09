import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeTarGz, tarGz } from '../testing/tar-fixtures.js';
import {
  type AcquireNodeBinaryOptions,
  acquireNodeBinary,
  type FetchLike,
  type FetchResponseLike,
  nodeDistLayout,
} from './node-dist.js';
import {
  NODE_DIST_MESSAGES,
  NodeDistError,
  type NodeDistErrorCode,
} from './node-errors.js';
import { NODE_PINS, type NodePinTable } from './node-pins.js';
import {
  nodeDistBinaryMember,
  nodeDistFile,
  nodeDistLicenseMember,
  TARGETS,
} from './targets.js';

const VERSION = '1.2.3';
const LINUX = { nodePlatform: 'linux', nodeArch: 'x64' } as const;
const WIN = { nodePlatform: 'win32', nodeArch: 'x64' } as const;
const BINARY = Buffer.from('#!fake-node-binary\n'.repeat(50));

const sha = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'node-dist-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function listAll(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    out.push(full);
    if (name.isDirectory()) out.push(...listAll(full));
  }
  return out.sort();
}

function response(
  body: Buffer | AsyncIterable<Uint8Array> | null,
  init: Partial<FetchResponseLike> & { length?: string } = {},
): FetchResponseLike {
  const headers: Record<string, string> = {};
  if (init.length !== undefined) headers['content-length'] = init.length;
  else if (Buffer.isBuffer(body))
    headers['content-length'] = String(body.length);
  return {
    status: init.status ?? 200,
    ...(init.redirected !== undefined ? { redirected: init.redirected } : {}),
    ...(init.url !== undefined ? { url: init.url } : {}),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: Buffer.isBuffer(body)
      ? (async function* () {
          for (let i = 0; i < body.length; i += 1000) {
            yield body.subarray(i, i + 1000);
          }
        })()
      : body,
  };
}

interface Harness {
  calls: Array<{ url: string; redirect: string }>;
  fetch: FetchLike;
}

function harness(
  make: (url: string) => FetchResponseLike | Promise<FetchResponseLike>,
): Harness {
  const calls: Harness['calls'] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      return make(url);
    },
  };
}

function setup(archive: Buffer, target = LINUX, file?: string) {
  const layout = nodeDistLayout(VERSION, target);
  const pins: NodePinTable = {
    [VERSION]: { [file ?? layout.distFile]: sha(archive) },
  };
  const cacheDir = join(root, 'cache');
  const outDir = join(root, 'out');
  mkdirSync(outDir, { recursive: true });
  const destination = join(outDir, 'sidecar-node');
  const licenseDestination = join(outDir, 'node-LICENSE');
  const base: AcquireNodeBinaryOptions = {
    version: VERSION,
    target,
    cacheDir,
    destination,
    pins,
    env: {},
  };
  return {
    layout,
    pins,
    cacheDir,
    outDir,
    destination,
    licenseDestination,
    base,
  };
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

const goodArchive = nodeTarGz(VERSION, 'linux', 'x64', { binary: BINARY });

describe('nodeDistLayout', () => {
  it('matches the target table for every supported target', () => {
    for (const spec of TARGETS) {
      const layout = nodeDistLayout(VERSION, spec);
      expect(layout.distFile).toBe(nodeDistFile(spec, VERSION));
      expect(layout.binaryMember).toBe(nodeDistBinaryMember(spec, VERSION));
      expect(layout.licenseMember).toBe(nodeDistLicenseMember(spec, VERSION));
      expect(layout.cacheName).not.toContain('/');
    }
  });

  it('refuses invalid versions and unknown targets', () => {
    for (const bad of [
      '26.8',
      'v26.8.1',
      '../1.2.3',
      '1.2.3-rc.1',
      '01.2.3',
      '',
    ]) {
      expect(() => nodeDistLayout(bad, LINUX)).toThrow(
        expect.objectContaining({ code: 'invalid_node_version' }),
      );
    }
    for (const target of [
      { nodePlatform: 'freebsd', nodeArch: 'x64' },
      { nodePlatform: 'linux', nodeArch: 'ia32' },
      { nodePlatform: '__proto__', nodeArch: 'x64' },
    ]) {
      expect(() => nodeDistLayout(VERSION, target)).toThrow(
        expect.objectContaining({ code: 'unsupported_target' }),
      );
    }
  });
});

describe('acquireNodeBinary', () => {
  it('downloads, verifies, extracts and writes the binary and license', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    const result = await acquireNodeBinary({
      ...s.base,
      licenseDestination: s.licenseDestination,
      fetch: h.fetch,
    });
    expect(h.calls).toEqual([
      {
        url: `https://nodejs.org/dist/v${VERSION}/node-v${VERSION}-linux-x64.tar.gz`,
        redirect: 'error',
      },
    ]);
    expect(result).toEqual({
      path: s.destination,
      sha256: sha(BINARY),
      version: VERSION,
      distFile: `node-v${VERSION}-linux-x64.tar.gz`,
      archiveSha256: sha(goodArchive),
      licensePath: s.licenseDestination,
    });
    expect(readFileSync(s.destination).equals(BINARY)).toBe(true);
    expect(readFileSync(s.licenseDestination, 'utf8')).toBe(
      'Node license text\n',
    );
    if (process.platform !== 'win32') {
      expect(statSync(s.destination).mode & 0o777).toBe(
        0o755 & ~process.umask(),
      );
      expect(statSync(join(s.cacheDir, VERSION)).mode & 0o777).toBe(0o700);
    }
    // Only the two outputs; no extracted tree, no partial files anywhere.
    expect(listAll(s.outDir)).toEqual(
      [s.licenseDestination, s.destination].sort(),
    );
    expect(listAll(s.cacheDir).filter((p) => p.includes('.partial-'))).toEqual(
      [],
    );
  });

  it('refuses an unpinned Node version before any network or file access', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    expect(
      await codeOf(
        acquireNodeBinary({ ...s.base, version: '9.9.9', fetch: h.fetch }),
      ),
    ).toBe('unpinned_version');
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          pins: { [VERSION]: {} },
          fetch: h.fetch,
        }),
      ),
    ).toBe('unpinned_file');
    expect(h.calls).toEqual([]);
    expect(existsSync(s.cacheDir)).toBe(false);
  });

  it('is fail-closed with the committed table for an unlisted version', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          pins: NODE_PINS,
          version: '0.0.1',
          fetch: h.fetch,
        }),
      ),
    ).toBe('unpinned_version');
    expect(h.calls).toEqual([]);
  });

  it('rejects a Node archive whose sha256 differs from the pin', async () => {
    const s = setup(goodArchive);
    const tampered = Buffer.from(goodArchive);
    tampered[tampered.length - 20] ^= 0xff;
    const h = harness(() => response(tampered));
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'checksum_mismatch',
    );
    expect(existsSync(s.destination)).toBe(false);
    // Nothing reached the cache, and no partial file is left behind.
    expect(listAll(s.cacheDir).filter((p) => statSync(p).isFile())).toEqual([]);
  });

  it('never extracts before the whole download is verified', async () => {
    // A valid tar.gz whose hash is wrong must not produce any output even
    // though its content would extract fine.
    const s = setup(goodArchive);
    const other = nodeTarGz(VERSION, 'linux', 'x64', {
      binary: Buffer.from('different'),
    });
    const h = harness(() => response(other));
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'checksum_mismatch',
    );
    expect(listAll(s.outDir)).toEqual([]);
  });

  it('refuses any redirect from the dist host', async () => {
    const s = setup(goodArchive);
    const variants: Array<() => FetchResponseLike> = [
      () => response(goodArchive, { status: 302 }),
      () => response(goodArchive, { status: 301 }),
      () => response(goodArchive, { redirected: true }),
      () => response(goodArchive, { url: 'https://evil.example/node.tar.gz' }),
    ];
    for (const make of variants) {
      const h = harness(() => make());
      expect(
        await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch })),
      ).toBe('redirect_refused');
      expect(h.calls[0]?.redirect).toBe('error');
    }
    expect(existsSync(s.destination)).toBe(false);
    expect(listAll(s.cacheDir).filter((p) => statSync(p).isFile())).toEqual([]);
  });

  it('maps a rejecting fetch (what redirect:error does) to a fixed error', async () => {
    const s = setup(goodArchive);
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed: https://secret.example/token');
    };
    try {
      await acquireNodeBinary({ ...s.base, fetch });
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as NodeDistError).code).toBe('fetch_failed');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('refuses a non-200 answer', async () => {
    const s = setup(goodArchive);
    for (const status of [404, 500, 206, 204]) {
      const h = harness(() => response(Buffer.from('nope'), { status }));
      expect(
        await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch })),
      ).toBe('http_status');
    }
  });

  it('refuses an http:// or otherwise insecure download location', async () => {
    const s = setup(goodArchive);
    for (const distBaseUrl of [
      'http://nodejs.org/dist',
      'ftp://nodejs.org/dist',
      'https://user:pass@nodejs.org/dist',
      'https://nodejs.org/dist?x=1',
      'https://nodejs.org/dist#frag',
      'not a url',
    ]) {
      const h = harness(() => response(goodArchive));
      expect(
        await codeOf(
          acquireNodeBinary({ ...s.base, distBaseUrl, fetch: h.fetch }),
        ),
      ).toBe('insecure_url');
      expect(h.calls).toEqual([]);
    }
  });

  it('accepts an https mirror base and builds the constant path under it', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    await acquireNodeBinary({
      ...s.base,
      distBaseUrl: 'https://mirror.example/node/dist/',
      fetch: h.fetch,
    });
    expect(h.calls[0]?.url).toBe(
      `https://mirror.example/node/dist/v${VERSION}/node-v${VERSION}-linux-x64.tar.gz`,
    );
  });

  it('refuses to run with TLS verification disabled', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
          fetch: h.fetch,
        }),
      ),
    ).toBe('tls_verification_disabled');
    expect(h.calls).toEqual([]);
  });

  it('aborts a download larger than the cap', async () => {
    const s = setup(goodArchive);
    // Declared too large.
    const declared = harness(() =>
      response(goodArchive, { length: String(10 * 1024 * 1024) }),
    );
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          limits: { maxDownloadBytes: 50 },
          fetch: declared.fetch,
        }),
      ),
    ).toBe('download_too_large');
    // Lying Content-Length, oversized stream.
    const streamed = harness(() => response(goodArchive, { length: '10' }));
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          limits: { maxDownloadBytes: 50 },
          fetch: streamed.fetch,
        }),
      ),
    ).toBe('download_too_large');
    expect(listAll(s.cacheDir).filter((p) => statSync(p).isFile())).toEqual([]);
  });

  it('cleans up the partial file when the download dies midway', async () => {
    const s = setup(goodArchive);
    const h = harness(() =>
      response(
        (async function* () {
          yield goodArchive.subarray(0, 500);
          throw new Error('connection reset /private/path');
        })(),
      ),
    );
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'fetch_failed',
    );
    expect(listAll(s.cacheDir).filter((p) => statSync(p).isFile())).toEqual([]);
    expect(existsSync(s.destination)).toBe(false);
  });

  it('cleans up when the body is missing or the download is truncated', async () => {
    const s = setup(goodArchive);
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          fetch: async () => response(null),
        }),
      ),
    ).toBe('fetch_failed');
    const h = harness(() =>
      response(goodArchive.subarray(0, 100), {
        length: String(goodArchive.length),
      }),
    );
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'checksum_mismatch',
    );
    expect(listAll(s.cacheDir).filter((p) => statSync(p).isFile())).toEqual([]);
  });

  it('uses the cache on the second run and re-verifies it', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    await acquireNodeBinary({ ...s.base, fetch: h.fetch });
    rmSync(s.destination);
    const second = await acquireNodeBinary({ ...s.base, fetch: h.fetch });
    expect(h.calls).toHaveLength(1);
    expect(second.sha256).toBe(sha(BINARY));
  });

  it('re-verifies a cached archive and refuses a poisoned cache entry', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    await acquireNodeBinary({ ...s.base, fetch: h.fetch });
    rmSync(s.destination);
    const cached = join(s.cacheDir, VERSION, s.layout.cacheName);
    // Same size, one flipped byte.
    const poisoned = Buffer.from(goodArchive);
    poisoned[100] ^= 0x01;
    writeFileSync(cached, poisoned);
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'cache_tampered',
    );
    // The poisoned entry was removed and NOT silently refetched.
    expect(existsSync(cached)).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(existsSync(s.destination)).toBe(false);
    // A later run starts clean from the network.
    await acquireNodeBinary({ ...s.base, fetch: h.fetch });
    expect(h.calls).toHaveLength(2);
  });

  it('treats a symlink or oversized cache entry as tampering', async () => {
    const s = setup(goodArchive);
    const cached = join(s.cacheDir, VERSION, s.layout.cacheName);
    mkdirSync(dirname(cached), { recursive: true });
    const outside = join(root, 'outside.tar.gz');
    writeFileSync(outside, goodArchive);
    symlinkSync(outside, cached);
    const h = harness(() => response(goodArchive));
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'cache_tampered',
    );
    expect(existsSync(cached)).toBe(false);
    // The symlink target was not deleted.
    expect(existsSync(outside)).toBe(true);

    writeFileSync(cached, goodArchive);
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          limits: { maxDownloadBytes: 10 },
          fetch: h.fetch,
        }),
      ),
    ).toBe('cache_tampered');
    expect(h.calls).toEqual([]);
  });

  it('does not touch the network when offline and the cache is cold', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    expect(
      await codeOf(
        acquireNodeBinary({ ...s.base, offline: true, fetch: h.fetch }),
      ),
    ).toBe('offline_cache_miss');
    expect(h.calls).toEqual([]);
  });

  it('survives colliding temp names with O_EXCL without clobbering', async () => {
    const s = setup(goodArchive);
    const cached = join(s.cacheDir, VERSION, s.layout.cacheName);
    mkdirSync(dirname(cached), { recursive: true });
    const squatted = `${cached}.partial-aaaa`;
    writeFileSync(squatted, 'attacker file');
    const squattedOut = `${s.destination}.partial-aaaa`;
    writeFileSync(squattedOut, 'attacker out');
    const names = ['aaaa', 'bbbb', 'aaaa', 'cccc'];
    const h = harness(() => response(goodArchive));
    await acquireNodeBinary({
      ...s.base,
      fetch: h.fetch,
      random: () => names.shift() ?? 'zzzz',
    });
    expect(readFileSync(squatted, 'utf8')).toBe('attacker file');
    expect(readFileSync(squattedOut, 'utf8')).toBe('attacker out');
    expect(readFileSync(s.destination).equals(BINARY)).toBe(true);
  });

  it('fails when every temp name collides', async () => {
    const s = setup(goodArchive);
    const cached = join(s.cacheDir, VERSION, s.layout.cacheName);
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(`${cached}.partial-same`, 'x');
    const h = harness(() => response(goodArchive));
    expect(
      await codeOf(
        acquireNodeBinary({ ...s.base, fetch: h.fetch, random: () => 'same' }),
      ),
    ).toBe('io_failed');
  });

  it('handles two concurrent acquisitions sharing one cache', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    const second = join(s.outDir, 'second-node');
    const [a, b] = await Promise.all([
      acquireNodeBinary({ ...s.base, fetch: h.fetch }),
      acquireNodeBinary({ ...s.base, destination: second, fetch: h.fetch }),
    ]);
    expect(a.sha256).toBe(b.sha256);
    expect(readFileSync(second).equals(BINARY)).toBe(true);
    expect(listAll(s.cacheDir).filter((p) => p.includes('.partial-'))).toEqual(
      [],
    );
    // Whatever interleaving happened, the cache entry is the pinned file.
    expect(
      sha(readFileSync(join(s.cacheDir, VERSION, s.layout.cacheName))),
    ).toBe(sha(goodArchive));
  });

  it('refuses to overwrite an existing destination', async () => {
    const s = setup(goodArchive);
    writeFileSync(s.destination, 'precious');
    const h = harness(() => response(goodArchive));
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'destination_exists',
    );
    expect(readFileSync(s.destination, 'utf8')).toBe('precious');
    expect(listAll(s.outDir)).toEqual([s.destination]);
  });

  it('refuses an existing license destination and leaves no binary behind', async () => {
    const s = setup(goodArchive);
    writeFileSync(s.licenseDestination, 'mine');
    const h = harness(() => response(goodArchive));
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          licenseDestination: s.licenseDestination,
          fetch: h.fetch,
        }),
      ),
    ).toBe('destination_exists');
    expect(existsSync(s.destination)).toBe(false);
  });

  it('writes nothing when the target check rejects the executable', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    let seen: Buffer | undefined;
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          fetch: h.fetch,
          verifyBinary: (binary) => {
            seen = binary;
            throw new Error('wrong architecture /secret');
          },
        }),
      ),
    ).toBe('binary_rejected');
    expect(seen?.equals(BINARY)).toBe(true);
    expect(listAll(s.outDir)).toEqual([]);
  });

  it('rejects a symlink binary member in a correctly hashed archive', async () => {
    const dir = `node-v${VERSION}-linux-x64`;
    const evil = tarGz([
      { name: `${dir}/bin/node`, type: '2', linkName: '/bin/sh' },
      { name: `${dir}/LICENSE`, data: 'x' },
    ]);
    const s = setup(evil);
    const h = harness(() => response(evil));
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          licenseDestination: s.licenseDestination,
          fetch: h.fetch,
        }),
      ),
    ).toBe('member_unsafe');
    expect(listAll(s.outDir)).toEqual([]);
  });

  it('rejects a hashed archive that lacks the binary or carries traversal names', async () => {
    const dir = `node-v${VERSION}-linux-x64`;
    for (const entries of [
      [{ name: `${dir}/LICENSE`, data: 'x' }],
      [
        { name: `../${dir}/bin/node`, data: 'evil' },
        { name: `/${dir}/bin/node`, data: 'evil' },
      ],
    ]) {
      const archive = tarGz(entries);
      const s = setup(archive);
      const h = harness(() => response(archive));
      expect(
        await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch })),
      ).toBe('member_missing');
      expect(listAll(s.outDir)).toEqual([]);
      rmSync(s.cacheDir, { recursive: true, force: true });
    }
  });

  it('stops a gzip bomb at the expansion cap', async () => {
    const dir = `node-v${VERSION}-linux-x64`;
    const bomb = tarGz([
      { name: `${dir}/filler`, data: Buffer.alloc(8 * 1024 * 1024, 7) },
      { name: `${dir}/bin/node`, data: 'late' },
    ]);
    expect(bomb.length).toBeLessThan(200 * 1024);
    const s = setup(bomb);
    const h = harness(() => response(bomb));
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          limits: { maxExpandedBytes: 1024 * 1024 },
          fetch: h.fetch,
        }),
      ),
    ).toBe('archive_too_large');
    expect(listAll(s.outDir)).toEqual([]);
  });

  it('rejects a hashed archive that is not gzip or is cut short', async () => {
    const notGzip = Buffer.from('this is not a gzip stream at all');
    let s = setup(notGzip);
    let h = harness(() => response(notGzip));
    expect(await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch }))).toBe(
      'archive_invalid',
    );
    rmSync(s.cacheDir, { recursive: true, force: true });
    const cut = goodArchive.subarray(0, Math.floor(goodArchive.length / 2));
    s = setup(cut);
    h = harness(() => response(cut));
    expect(['archive_truncated', 'archive_invalid']).toContain(
      await codeOf(acquireNodeBinary({ ...s.base, fetch: h.fetch })),
    );
    expect(listAll(s.outDir)).toEqual([]);
  });

  it('uses a local archive (--node-archive) with the same pin check', async () => {
    const s = setup(goodArchive);
    const archivePath = join(root, 'my-node.tar.gz');
    writeFileSync(archivePath, goodArchive);
    const h = harness(() => response(goodArchive));
    const ok = await acquireNodeBinary({
      ...s.base,
      archivePath,
      fetch: h.fetch,
    });
    expect(ok.sha256).toBe(sha(BINARY));
    expect(h.calls).toEqual([]);
    expect(existsSync(s.cacheDir)).toBe(false);

    rmSync(s.destination);
    writeFileSync(archivePath, gzipSync(Buffer.from('other')));
    expect(await codeOf(acquireNodeBinary({ ...s.base, archivePath }))).toBe(
      'checksum_mismatch',
    );
    // A user-supplied file is never deleted.
    expect(existsSync(archivePath)).toBe(true);
    expect(
      await codeOf(
        acquireNodeBinary({ ...s.base, archivePath: join(root, 'missing') }),
      ),
    ).toBe('untrusted_file');
  });

  it('handles the standalone Windows node.exe without any archive', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 3)]);
    const s = setup(exe, WIN);
    const h = harness(() => response(exe));
    const result = await acquireNodeBinary({
      ...s.base,
      licenseDestination: s.licenseDestination,
      fetch: h.fetch,
    });
    expect(h.calls[0]?.url).toBe(
      `https://nodejs.org/dist/v${VERSION}/win-x64/node.exe`,
    );
    expect(result.distFile).toBe('win-x64/node.exe');
    expect(result.sha256).toBe(sha(exe));
    expect(result.archiveSha256).toBe(sha(exe));
    expect(result.licensePath).toBeUndefined();
    expect(readFileSync(s.destination).equals(exe)).toBe(true);
    expect(existsSync(s.licenseDestination)).toBe(false);
    expect(existsSync(join(s.cacheDir, VERSION, 'win-x64-node.exe'))).toBe(
      true,
    );
  });

  it('requires absolute cache and output paths', async () => {
    const s = setup(goodArchive);
    for (const patch of [
      { cacheDir: 'relative/cache' },
      { destination: 'relative/node' },
      { licenseDestination: 'relative/LICENSE' },
    ]) {
      expect(await codeOf(acquireNodeBinary({ ...s.base, ...patch }))).toBe(
        'invalid_path',
      );
    }
  });

  it('records the binary hash, not the archive hash, as sha256', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    const result = await acquireNodeBinary({ ...s.base, fetch: h.fetch });
    expect(result.sha256).toBe(sha(BINARY));
    expect(result.sha256).not.toBe(result.archiveSha256);
  });

  it('cleans up the first output when the second cannot be created', async () => {
    const s = setup(goodArchive);
    const h = harness(() => response(goodArchive));
    // License parent directory does not exist -> temp create fails.
    const badLicense = join(root, 'nope', 'LICENSE');
    expect(
      await codeOf(
        acquireNodeBinary({
          ...s.base,
          licenseDestination: badLicense,
          fetch: h.fetch,
        }),
      ),
    ).toBe('io_failed');
    expect(listAll(s.outDir)).toEqual([]);
  });
});

describe('error messages', () => {
  it('are fixed, value-free text', () => {
    for (const [code, message] of Object.entries(NODE_DIST_MESSAGES)) {
      expect(new NodeDistError(code as NodeDistErrorCode).message).toBe(
        message,
      );
      expect(message).not.toMatch(/[/\\]|https?:|\d+\.\d+\.\d+/);
    }
  });
});
