import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discoverSourceFiles = vi.hoisted(() => vi.fn(async () => [] as string[]));

vi.mock('../../utils/import-workspace-module.js', () => ({
  importWorkspaceModule: vi.fn(async () => ({ discoverSourceFiles })),
}));

import { ManifestBuilder } from '../generator.js';

describe('ManifestBuilder discovery bounds', () => {
  beforeEach(() => {
    discoverSourceFiles.mockClear();
  });

  it('applies the scanner discovery bounds to its preflight glob', async () => {
    const cwd = resolve(process.cwd());
    const absoluteInclude = resolve(cwd, 'src/**/*.ts');

    await new ManifestBuilder().generate({
      include: [absoluteInclude],
      exclude: [],
    });

    expect(discoverSourceFiles).toHaveBeenCalledWith({
      cwd,
      include: [absoluteInclude],
      exclude: [],
      followSymbolicLinks: false,
    });
  });

  it('passes an explicit symlink opt-in to its preflight glob', async () => {
    await new ManifestBuilder().generate({ followSymbolicLinks: true });

    expect(discoverSourceFiles).toHaveBeenCalledWith(
      expect.objectContaining({ followSymbolicLinks: true }),
    );
  });
});
