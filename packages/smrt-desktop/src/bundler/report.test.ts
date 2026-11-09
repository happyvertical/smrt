import { describe, expect, it } from 'vitest';
import { BundleError } from './errors.js';
import {
  type BundleReportV1,
  formatFileList,
  parseBundleReport,
  serializeBundleReport,
  validateBundleReport,
} from './report.js';
import { sampleBundleReport, sha } from './testing/report-fixture.js';

const sample = sampleBundleReport;

function reject(mutate: (report: Record<string, any>) => void): void {
  const copy = JSON.parse(JSON.stringify(sample()));
  mutate(copy);
  expect(() => validateBundleReport(copy)).toThrow(BundleError);
  try {
    validateBundleReport(copy);
  } catch (error) {
    expect((error as BundleError).code).toBe('report_invalid');
  }
}

describe('bundle report schema', () => {
  it('serializes canonically and parses back to the same value', () => {
    const text = serializeBundleReport(sample());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "version": 1,\n  "tool"')).toBe(true);
    expect(parseBundleReport(text)).toEqual(sample());
    expect(serializeBundleReport(parseBundleReport(text))).toBe(text);
  });

  it('writes keys in the schema order whatever the input order', () => {
    const scrambled = Object.fromEntries(
      Object.entries(sample()).reverse(),
    ) as unknown as BundleReportV1;
    expect(serializeBundleReport(scrambled)).toBe(
      serializeBundleReport(sample()),
    );
  });

  it('carries no timestamp, path or host name', () => {
    const text = serializeBundleReport(sample());
    expect(text).not.toMatch(/generatedAt|timestamp|hostname|"\/|\\\\/i);
  });

  it('accepts optional inputs and measurements', () => {
    const report: BundleReportV1 = {
      ...sample(),
      inputs: {
        ...sample().inputs,
        workspaceYamlSha256: sha('a'),
        npmrcSha256: sha('c'),
        patchesSha256: sha('b'),
      },
      measurements: {
        nodeVersionOutput: 'v26.8.1',
        healthRoute: '/api/_runtime/health',
        installed: { apparentBytes: 20, onDiskBytes: 4096, files: 2 },
        coldStart: {
          firstRun: { runs: 2, samplesMs: [10, 12], medianMs: 11, maxMs: 12 },
          warm: { runs: 1, samplesMs: [5], medianMs: 5, maxMs: 5 },
        },
      },
    };
    expect(parseBundleReport(serializeBundleReport(report))).toEqual(report);
  });

  it('rejects unknown keys at every level', () => {
    reject((r) => {
      r.extra = 1;
    });
    reject((r) => {
      r.tool.extra = 1;
    });
    reject((r) => {
      r.files.breakdown.extra = 1;
    });
    reject((r) => {
      r.packages[0].extra = 1;
    });
  });

  it('rejects missing keys, wrong types and bad values', () => {
    reject((r) => {
      delete r.target;
    });
    reject((r) => {
      r.version = 2;
    });
    reject((r) => {
      delete r.files.tauriBundleSha256;
    });
    reject((r) => {
      r.inputs.npmrcSha256 = 'abc';
    });
    reject((r) => {
      r.inputs.lockfileSha256 = 'abc';
    });
    reject((r) => {
      r.inputs.lockfileSha256 = sha('A');
    });
    reject((r) => {
      r.files.count = -1;
    });
    reject((r) => {
      r.files.bytes = 1.5;
    });
    reject((r) => {
      r.node.machine = 'x86';
    });
    reject((r) => {
      r.natives = [
        { path: 'a', format: 'coff', kind: 'library', machines: [] },
      ];
    });
    reject((r) => {
      r.host.node = 26;
    });
    reject((r) => {
      r.bridge.file = '/abs/path.mjs';
    });
    reject((r) => {
      r.bridge.file = '../escape.mjs';
    });
    reject((r) => {
      r.tool.name = 'a\nb';
    });
    reject((r) => {
      r.measurements = { nodeVersionOutput: 'v26' };
    });
  });

  it('rejects lists that are not sorted or contain duplicates', () => {
    reject((r) => {
      r.packages.reverse();
    });
    reject((r) => {
      r.packages.push({ ...r.packages[1] });
    });
    reject((r) => {
      r.features.enabled = ['z', 'a'];
    });
  });

  it('rejects duplicate keys and malformed JSON when parsing text', () => {
    const text = serializeBundleReport(sample());
    expect(() =>
      parseBundleReport(
        text.replace('"version": 1,', '"version": 1, "version": 1,'),
      ),
    ).toThrow(BundleError);
    expect(() => parseBundleReport('{')).toThrow(BundleError);
    expect(() => parseBundleReport('[]')).toThrow(BundleError);
  });
});

describe('file list', () => {
  const entries = [
    { path: 'resources/a-b', sha256: sha('b') },
    { path: 'resources/a/b', sha256: sha('c') },
    { path: 'binaries/node', sha256: sha('a') },
  ];

  it('is sorted by UTF-16 code unit order and ends with a newline', () => {
    const text = formatFileList(entries);
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(66)),
    ).toEqual(['binaries/node', 'resources/a-b', 'resources/a/b']);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('does not depend on the order it was given', () => {
    expect(formatFileList([...entries].reverse())).toBe(
      formatFileList(entries),
    );
  });

  it('refuses duplicates, bad digests and newlines in paths', () => {
    expect(() => formatFileList([entries[0], entries[0]] as never)).toThrow(
      BundleError,
    );
    expect(() => formatFileList([{ path: 'a', sha256: 'zz' }])).toThrow(
      BundleError,
    );
    expect(() => formatFileList([{ path: 'a\nb', sha256: sha('a') }])).toThrow(
      BundleError,
    );
  });
});
