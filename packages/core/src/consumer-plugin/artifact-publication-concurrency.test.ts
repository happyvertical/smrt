import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  type ArtifactFilesystem,
  publishAtomicArtifact,
} from './artifact-publication';

it('preserves each writer staging file when same-process publications overlap', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'smrt-publication-overlap-'));
  const path = join(directory, 'knowledge.json');
  const outer = JSON.stringify({ writer: 'outer', complete: true });
  const inner = JSON.stringify({ writer: 'inner', complete: true });
  fs.writeFileSync(path, JSON.stringify({ writer: 'original' }), {
    mode: 0o640,
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(42);
  const stagedPaths: string[] = [];
  const observed: string[] = [];
  let nested = false;
  const filesystem: ArtifactFilesystem = {
    ...fs,
    writeFileSync: (...args) => {
      fs.writeFileSync(...args);
      stagedPaths.push(String(args[0]));
      if (!nested) {
        nested = true;
        // Pause the first publication after staging while another writer
        // completes. Both writers share a PID and the same clock tick.
        publishAtomicArtifact({ path, content: inner }, filesystem);
        observed.push(fs.readFileSync(path, 'utf8'));
      }
    },
  };

  try {
    expect(() =>
      publishAtomicArtifact({ path, content: outer }, filesystem),
    ).not.toThrow();
    expect(new Set(stagedPaths).size).toBe(2);
    expect(observed).toEqual([inner]);
    expect(fs.readFileSync(path, 'utf8')).toBe(outer);
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(directory)).toEqual(['knowledge.json']);
  } finally {
    clock.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
