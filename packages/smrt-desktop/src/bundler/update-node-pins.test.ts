import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; only its pure exports run.
import * as script from '../../scripts/update-node-pins.mjs';
import {
  NODE_PIN_PROVENANCE,
  NODE_PINS,
  pinProvenanceProblems,
} from './node-pins.js';
import { nodeDistFile, TARGETS } from './targets.js';

const here = dirname(fileURLToPath(import.meta.url));
const pinsSource = readFileSync(join(here, 'node-pins.ts'), 'utf8');

const H = (c: string) => c.repeat(64);
const FPR_A = 'A'.repeat(40);
const FPR_B = 'B'.repeat(40);

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
      pins,
      provenance: script.buildProvenance({
        version: '26.9.0',
        retrieved: '2026-12-01T00:00:00Z',
        shasumsSha256: H('9'),
        signerFingerprints: [FPR_A],
      }),
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
    expect(merged).toContain("verification: 'gpg-verified'");
    expect(merged).toContain(`signerFingerprints: ['${FPR_A}']`);
    // The 26.8.1 record is untouched and still unverified.
    const kept = script
      .parsePinsBlock(merged)
      .find((r: { version: string }) => r.version === '26.8.1');
    expect(kept.provenance.verification).toBe('unverified');
  });

  it('round-trips verified records with one, two and no signer fingerprints', () => {
    const pins = script.selectPins(
      '26.9.0',
      script.parseShasums(shasumsFor('26.9.0')),
    );
    const make = (version: string, signerFingerprints: string[]) => ({
      version,
      pins: script.selectPins(
        version,
        script.parseShasums(shasumsFor(version)),
      ),
      provenance: script.buildProvenance({
        version,
        retrieved: '2026-12-01T00:00:00Z',
        shasumsSha256: H('9'),
        signerFingerprints,
      }),
    });
    void pins;
    const records = [
      make('26.11.0', [FPR_A, FPR_B]),
      make('26.10.0', [FPR_A]),
      make('26.9.0', []),
    ];
    const block = script.renderPinsBlock(records);
    const parsed = script.parsePinsBlock(`${block}\n`);
    expect(parsed).toEqual(records);
    expect(parsed[2].provenance.verification).toBe('unverified');
    expect(parsed[1].provenance.verification).toBe('gpg-verified');
    expect(block).toContain(`      '${FPR_A}',\n      '${FPR_B}',`);
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
    // Flipping the status by hand, without signer fingerprints, is refused.
    expect(() =>
      script.parsePinsBlock(
        pinsSource.replace(
          "verification: 'unverified'",
          "verification: 'gpg-verified'",
        ),
      ),
    ).toThrow();
    // A provenance record without its pins (or the reverse) is refused.
    expect(() =>
      script.parsePinsBlock(
        pinsSource.replace(
          "'26.8.1': {\n    verification",
          "'26.8.2': {\n    verification",
        ),
      ),
    ).toThrow();
  });

  it('agrees with the runtime check on what makes a record sound', () => {
    const base = {
      verification: 'gpg-verified',
      source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
      retrieved: '2026-12-01T00:00:00Z',
      shasumsSha256: H('9'),
      signerFingerprints: [FPR_A],
    };
    const samples: unknown[] = [
      base,
      { ...base, verification: 'unverified' },
      { ...base, verification: 'unverified', signerFingerprints: [] },
      { ...base, signerFingerprints: [] },
      { ...base, signerFingerprints: [FPR_A, FPR_A] },
      { ...base, signerFingerprints: ['a'.repeat(40)] },
      { ...base, shasumsSha256: 'abc' },
      { ...base, source: 'http://nodejs.org/dist/v26.8.1/SHASUMS256.txt' },
      { ...base, source: 'https://example.com/SHASUMS256.txt' },
      { ...base, retrieved: 'yesterday' },
      { ...base, verification: 'verified' },
      null,
      'x',
    ];
    for (const sample of samples) {
      expect(script.provenanceProblems(sample)).toEqual(
        pinProvenanceProblems(sample),
      );
    }
    expect(script.provenanceProblems(base)).toEqual([]);
    expect(script.provenanceProblems(samples[3])).toEqual([
      'signerFingerprints',
    ]);
  });

  it('refuses to render a record that claims verification without signers', () => {
    const pins = script.selectPins(
      '1.2.3',
      script.parseShasums(shasumsFor('1.2.3')),
    );
    const provenance = {
      verification: 'gpg-verified',
      source: 'https://nodejs.org/dist/v1.2.3/SHASUMS256.txt',
      retrieved: '2026-12-01T00:00:00Z',
      shasumsSha256: H('9'),
      signerFingerprints: [],
    };
    expect(() =>
      script.renderPinsBlock([{ version: '1.2.3', pins, provenance }]),
    ).toThrow(/malformed provenance/);
  });

  it('keeps the committed provenance in step with the committed pins', () => {
    const records = script.parsePinsBlock(pinsSource);
    expect(
      Object.fromEntries(
        records.map((r: { version: string; provenance: unknown }) => [
          r.version,
          r.provenance,
        ]),
      ),
    ).toEqual(JSON.parse(JSON.stringify(NODE_PIN_PROVENANCE)));
  });

  it('gives every download an overall timeout and refuses redirects', async () => {
    let seen: { redirect?: string; signal?: AbortSignal } = {};
    const hanging = ((_url: string, init: RequestInit) => {
      seen = init as typeof seen;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    }) as unknown as typeof fetch;
    await expect(
      script.download('https://nodejs.org/dist/x', {
        fetchImpl: hanging,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('download timed out');
    expect(seen.redirect).toBe('error');
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(script.FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(script.FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    await expect(script.download('http://nodejs.org/x')).rejects.toThrow(
      /non-https/,
    );
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
      expect(stdout).toContain('recorded 6 pins for Node 26.9.0 (unverified)');
      const written = readFileSync(out, 'utf8');
      const records = script.parsePinsBlock(written);
      expect(records.map((r: { version: string }) => r.version)).toEqual([
        '26.9.0',
        '26.8.1',
      ]);
      const fresh = records[0] as {
        provenance: { verification: string; signerFingerprints: string[] };
      };
      expect(fresh.provenance.verification).toBe('unverified');
      expect(fresh.provenance.signerFingerprints).toEqual([]);
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
