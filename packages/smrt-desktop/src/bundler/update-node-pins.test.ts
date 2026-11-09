import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; only its pure exports run.
import * as script from '../../scripts/update-node-pins.mjs';
import { NODE_PINS } from './node-pins.js';
import { nodeDistFile, TARGETS } from './targets.js';

const here = dirname(fileURLToPath(import.meta.url));
const pinsSource = readFileSync(join(here, 'node-pins.ts'), 'utf8');

const H = (c: string) => c.repeat(64);

function shasumsFor(version: string, extra = ''): string {
  const lines = script
    .requiredDistFiles(version)
    .map((file: string, i: number) => `${H('abcdef'[i] as string)}  ${file}`);
  return `${[...lines, `${H('1')}  node-v${version}-aix-ppc64.tar.gz`].join('\n')}\n${extra}`;
}

describe('update-node-pins (offline parts)', () => {
  it('requires exactly the dist files the target table uses', () => {
    const version = '26.8.1';
    expect([...script.requiredDistFiles(version)].sort()).toEqual(
      TARGETS.map((spec) => nodeDistFile(spec, version)).sort(),
    );
  });

  it('parses SHASUMS256.txt and rejects malformed or duplicate lines', () => {
    const parsed = script.parseShasums(shasumsFor('1.2.3'));
    expect(parsed.get('win-x64/node.exe')).toBe(H('f'));
    expect(parsed.size).toBe(7);
    for (const bad of [
      `${H('a')} one-space-only\n`,
      `${'A'.repeat(64)}  UPPER\n`,
      `${H('a')}  x\n${H('b')}  x\n`,
      'garbage\n',
      `${'a'.repeat(63)}  short\n`,
    ]) {
      expect(() => script.parseShasums(bad)).toThrow();
    }
    expect(script.parseShasums(`${H('a')}  x\r\n`).get('x')).toBe(H('a'));
  });

  it('selects the six pins sorted, and refuses a partial table', () => {
    const entries = script.parseShasums(shasumsFor('1.2.3'));
    const pins = script.selectPins('1.2.3', entries);
    expect(pins).toHaveLength(6);
    expect(pins.map(([file]: [string]) => file)).toEqual(
      [...pins.map(([file]: [string]) => file)].sort(),
    );
    entries.delete('win-arm64/node.exe');
    expect(() => script.selectPins('1.2.3', entries)).toThrow(
      /lacks a required/,
    );
    expect(() => script.selectPins('../1', entries)).toThrow();
  });

  it('accepts a signature only from a trusted primary key with no bad status', () => {
    const fpr = 'A'.repeat(40);
    const sub = 'B'.repeat(40);
    const good = `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG KEYID Someone\n[GNUPG:] VALIDSIG ${sub} 2026-01-01 1 0 4 0 1 10 00 ${fpr}\n`;
    const parsed = script.parseGpgStatus(good);
    expect(parsed).toEqual({ validPrimaryFingerprints: [fpr], bad: false });
    expect(script.isTrustedSignature(parsed, [fpr])).toBe(true);
    expect(script.isTrustedSignature(parsed, ['C'.repeat(40)])).toBe(false);
    expect(script.isTrustedSignature(parsed, [])).toBe(false);
    const bad = script.parseGpgStatus(`${good}[GNUPG:] BADSIG KEYID x\n`);
    expect(script.isTrustedSignature(bad, [fpr])).toBe(false);
    for (const keyword of ['ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG']) {
      expect(
        script.isTrustedSignature(
          script.parseGpgStatus(`${good}[GNUPG:] ${keyword} k\n`),
          [fpr],
        ),
      ).toBe(false);
    }
    // No signature at all is never trusted.
    expect(script.isTrustedSignature(script.parseGpgStatus(''), [fpr])).toBe(
      false,
    );
    // Lookalike text that is not a status line is ignored.
    expect(
      script.parseGpgStatus(`VALIDSIG ${sub} 1 2 3 4 5 6 7 8 ${fpr}\n`)
        .validPrimaryFingerprints,
    ).toEqual([]);
  });

  it('parses fingerprint lists', () => {
    const f = 'ab'.repeat(20);
    expect(
      script.parseFingerprints(
        `# comment\n${f} # trailing\n\n${f.toUpperCase()}\n`,
      ),
    ).toEqual([f.toUpperCase(), f.toUpperCase()]);
    expect(
      script.parseFingerprints(
        'AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111 2222 3333',
      ),
    ).toEqual(['AAAABBBBCCCCDDDDEEEEFFFF0000111122223333']);
    expect(() => script.parseFingerprints('not-hex\n')).toThrow();
    expect(() => script.parseFingerprints('ABCD\n')).toThrow();
  });

  it('keeps the committed pin file in exactly the generated form', () => {
    const records = script.parsePinsBlock(pinsSource);
    const start = pinsSource.indexOf(script.BEGIN_MARKER);
    const end =
      pinsSource.indexOf(script.END_MARKER) + script.END_MARKER.length;
    expect(script.renderPinsBlock(records)).toBe(pinsSource.slice(start, end));
  });

  it('parses the committed block to exactly the exported table', () => {
    const records = script.parsePinsBlock(pinsSource);
    const fromBlock = Object.fromEntries(
      records.map((r: { version: string; pins: Array<[string, string]> }) => [
        r.version,
        Object.fromEntries(r.pins),
      ]),
    );
    expect(fromBlock).toEqual(NODE_PINS);
  });

  it('merges a new version above older ones and replaces a re-run', () => {
    const pins = script.selectPins(
      '26.9.0',
      script.parseShasums(shasumsFor('26.9.0')),
    );
    const record = {
      version: '26.9.0',
      comment: script.provenanceComment({
        version: '26.9.0',
        source: 'https://nodejs.org/dist/v26.9.0/SHASUMS256.txt',
        retrieved: '2026-12-01T00:00:00Z',
        shasumsSha256: H('9'),
        signature: 'verified with gpg (primary key X)',
      }),
      pins,
    };
    const merged = script.mergePinsSource(pinsSource, record);
    const versions = script
      .parsePinsBlock(merged)
      .map((r: { version: string }) => r.version);
    expect(versions).toEqual(['26.9.0', '26.8.1']);
    // Code outside the block is untouched.
    expect(merged.slice(0, merged.indexOf(script.BEGIN_MARKER))).toBe(
      pinsSource.slice(0, pinsSource.indexOf(script.BEGIN_MARKER)),
    );
    expect(merged.slice(merged.indexOf(script.END_MARKER))).toBe(
      pinsSource.slice(pinsSource.indexOf(script.END_MARKER)),
    );
    // Old pins survive byte for byte; a re-run replaces instead of duplicating.
    const again = script.mergePinsSource(merged, record);
    expect(again).toBe(merged);
    const reRun = script.mergePinsSource(merged, {
      ...record,
      pins: pins.slice().reverse(),
    });
    expect(script.parsePinsBlock(reRun)).toHaveLength(2);
    expect(merged).toContain('signature: verified with gpg');
  });

  it('refuses a source without markers or with a hand-edited block', () => {
    expect(() => script.parsePinsBlock('export const x = 1;\n')).toThrow();
    expect(() =>
      script.parsePinsBlock(
        pinsSource.replace("'26.8.1': {", "'26.8.1': { // x"),
      ),
    ).toThrow();
    expect(() =>
      script.parsePinsBlock(pinsSource.replace('6e577fd0d9db', '6E577FD0D9DB')),
    ).toThrow();
  });

  it('refuses to render a malformed pin', () => {
    const record = (file: string, hash: string) => ({
      version: '1.0.0',
      comment: [],
      pins: [[file, hash]],
    });
    expect(() => script.renderPinsBlock([record('f', 'abc')])).toThrow();
    expect(() => script.renderPinsBlock([record("f'x", H('a'))])).toThrow();
    expect(() =>
      script.renderPinsBlock([{ ...record('f', H('a')), version: '1.0' }]),
    ).toThrow();
  });

  it('parses command-line arguments strictly', () => {
    const { version, options } = script.parseArgs([
      '26.8.1',
      '--gnupghome',
      '/g',
      '--dry-run',
    ]);
    expect(version).toBe('26.8.1');
    expect(options.get('--gnupghome')).toBe('/g');
    expect(options.get('--dry-run')).toBe(true);
    expect(() => script.parseArgs([])).toThrow();
    expect(() => script.parseArgs(['26.8'])).toThrow();
    expect(() => script.parseArgs(['26.8.1', '--bogus'])).toThrow();
    expect(() => script.parseArgs(['26.8.1', '--out'])).toThrow();
    expect(() => script.parseArgs(['26.8.1', '--out', '--dry-run'])).toThrow();
  });

  it('never touches the network or gpg when imported', () => {
    expect(typeof script.parseShasums).toBe('function');
    expect(script.DIST_BASE).toBe('https://nodejs.org/dist');
  });

  it('runs end to end offline from local files with --unverified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-pins-'));
    try {
      const shasums = join(dir, 'SHASUMS256.txt');
      const out = join(dir, 'node-pins.ts');
      writeFileSync(shasums, shasumsFor('26.9.0'));
      writeFileSync(out, pinsSource);
      const stdout = execFileSync(
        process.execPath,
        [
          join(here, '..', '..', 'scripts', 'update-node-pins.mjs'),
          '26.9.0',
          '--shasums',
          shasums,
          '--unverified',
          '--out',
          out,
        ],
        { encoding: 'utf8' },
      );
      expect(stdout).toContain('recorded 6 pins for Node 26.9.0');
      const written = readFileSync(out, 'utf8');
      const records = script.parsePinsBlock(written);
      expect(records.map((r: { version: string }) => r.version)).toEqual([
        '26.9.0',
        '26.8.1',
      ]);
      expect(written).toContain('signature: NOT VERIFIED (--unverified)');
      // Without --unverified and without gpg inputs the script refuses.
      expect(() =>
        execFileSync(
          process.execPath,
          [
            join(here, '..', '..', 'scripts', 'update-node-pins.mjs'),
            '26.9.0',
            '--shasums',
            shasums,
            '--out',
            out,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
