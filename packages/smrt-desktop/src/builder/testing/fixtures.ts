/**
 * In-memory fakes for `runBuild`: a filesystem keyed by path and a child
 * runner that records its calls. No real tauri, cargo or node is ever started.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { serializeBundleReport } from '../../bundler/report.js';
import { sampleBundleReport } from '../../bundler/testing/report-fixture.js';
import { TAURI_CLI_VERSION } from '../constants.js';
import type { BuildFs, BuildSeams, ChildRequest, EntryKind } from '../run.js';

const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');

export class FakeFs implements BuildFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['/']);
  readonly others = new Set<string>();
  readonly writes: string[] = [];
  private counter = 0;

  put(path: string, content: string | Uint8Array): void {
    this.files.set(
      path,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    );
    let dir = join(path, '..');
    while (!this.dirs.has(dir)) {
      this.dirs.add(dir);
      dir = join(dir, '..');
    }
  }
  async kind(path: string): Promise<EntryKind> {
    if (this.others.has(path)) return 'other';
    if (this.files.has(path)) return 'file';
    if (this.dirs.has(path)) return 'dir';
    return 'missing';
  }
  async readFile(path: string, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes || bytes.length > maxBytes) throw new Error('read');
    return bytes;
  }
  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) throw new Error('readdir');
    const names = new Set<string>();
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const entry of [...this.files.keys(), ...this.dirs, ...this.others]) {
      if (entry !== path && entry.startsWith(prefix)) {
        names.add(entry.slice(prefix.length).split('/')[0] as string);
      }
    }
    return [...names].sort();
  }
  async mkdirp(path: string): Promise<void> {
    let dir = path;
    while (!this.dirs.has(dir)) {
      this.dirs.add(dir);
      dir = join(dir, '..');
    }
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (this.files.has(path)) throw new Error('exists');
    this.writes.push(path);
    this.put(path, data);
  }
  async mkdtemp(parent: string, prefix: string): Promise<string> {
    this.counter += 1;
    const path = join(parent, `${prefix}${this.counter}`);
    this.dirs.add(path);
    return path;
  }
  async rename(from: string, to: string): Promise<void> {
    for (const [path, bytes] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.put(to + path.slice(from.length), bytes);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === from || dir.startsWith(`${from}/`)) {
        this.dirs.delete(dir);
        this.dirs.add(to + dir.slice(from.length));
      }
    }
  }
  async removeTree(path: string): Promise<void> {
    for (const entry of [...this.files.keys()]) {
      if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    }
    for (const dir of [...this.dirs]) {
      if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
    }
  }
}

export const TARGET = 'aarch64-apple-darwin';
export const PACKAGE_VERSION = '1.2.3';

export interface Fixture {
  readonly fs: FakeFs;
  readonly calls: ChildRequest[];
  readonly seams: BuildSeams;
  readonly stages: string[];
  /** What `tauri --version` prints; mutable per test. */
  tauriVersion: string;
  /** Exit code per command name. */
  exit: Record<string, number>;
  /** Produce an installer under the scratch tree when tauri runs. */
  produce: boolean;
}

/** A complete app, bundle and packaged wrapper, all at the fixed paths below. */
export function createFixture(
  overrides: {
    config?: Record<string, unknown>;
    cargoVersion?: string;
    reportTarget?: string;
  } = {},
): Fixture {
  const fs = new FakeFs();
  const app = '/work/app';
  const bundle = '/work/bundle';
  const pkg = '/pkg';
  const config = {
    version: 1,
    productId: 'demo',
    bundleId: 'com.example.demo',
    displayName: 'Demo App',
    icons: ['icons/icon.png', 'icons/icon.ico'],
    updaterPublicKey: 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=',
    ...overrides.config,
  };
  fs.put(`${app}/smrt-desktop.json`, JSON.stringify(config));
  fs.put(`${app}/icons/icon.png`, 'png');
  fs.put(`${app}/icons/icon.ico`, 'ico');

  const sidecar = `binaries/demo-node-${TARGET}`;
  const files: Record<string, string> = {
    [sidecar]: 'node-binary',
    'resources/sidecar-manifest.json': '{}',
  };
  for (const [path, content] of Object.entries(files)) {
    fs.put(`${bundle}/${path}`, content);
  }
  fs.put(
    `${bundle}/bundle-files.sha256`,
    `${Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, content]) => `${sha(content)}  ${path}\n`)
      .join('')}`,
  );
  fs.put(
    `${bundle}/tauri.bundle.json`,
    JSON.stringify({
      bundle: {
        externalBin: ['binaries/demo-node'],
        resources: { 'resources/': './' },
      },
    }),
  );
  fs.put(
    `${bundle}/bundle-report.json`,
    reportText(config, overrides.reportTarget),
  );

  fs.put(
    `${pkg}/package.json`,
    JSON.stringify({
      name: '@happyvertical/smrt-desktop',
      version: PACKAGE_VERSION,
    }),
  );
  const cargo = overrides.cargoVersion ?? PACKAGE_VERSION;
  fs.put(
    `${pkg}/wrapper/Cargo.toml`,
    `[package]\nname = "smrt-desktop-wrapper"\nversion = "${cargo}"\n\n[dependencies]\nserde = { version = "1" }\n`,
  );
  fs.put(
    `${pkg}/wrapper/Cargo.lock`,
    `[[package]]\nname = "smrt-desktop-wrapper"\nversion = "${cargo}"\n`,
  );
  fs.put(`${pkg}/wrapper/build.rs`, 'fn main() {}');
  fs.put(`${pkg}/wrapper/tauri.conf.json`, '{}');
  fs.put(`${pkg}/wrapper/capabilities/default.json`, '{}');
  fs.put(`${pkg}/wrapper/frontend/index.html`, '<html></html>');
  fs.put(`${pkg}/wrapper/icons/icon.png`, 'x');
  fs.put(`${pkg}/wrapper/src/main.rs`, 'fn main() {}');
  fs.put(`${pkg}/wrapper/scripts/launch-smoke.mjs`, '//');
  fs.put(`${pkg}/wrapper/scripts/smoke-support.mjs`, '//');

  const calls: ChildRequest[] = [];
  const stages: string[] = [];
  const fixture: Fixture = {
    fs,
    calls,
    stages,
    tauriVersion: `tauri-cli ${TAURI_CLI_VERSION}`,
    exit: {},
    produce: true,
    seams: undefined as unknown as BuildSeams,
  };
  const seams: BuildSeams = {
    fs,
    wrapperRoot: `${pkg}/wrapper`,
    nodePath: '/usr/bin/node',
    platform: 'darwin',
    env: {
      PATH: '/usr/bin',
      HOME: '/home/x',
      APPLE_PASSWORD: 'never-forwarded',
      TAURI_SIGNING_PRIVATE_KEY: 'never-forwarded',
      NPM_TOKEN: 'never-forwarded',
    },
    onStage: (stage) => stages.push(stage),
    async capture(request) {
      calls.push(request);
      return { code: 0, stdout: `${fixture.tauriVersion}\n` };
    },
    async run(request) {
      calls.push(request);
      const code = fixture.exit[request.command] ?? 0;
      if (request.command === 'tauri' && code === 0 && fixture.produce) {
        fs.put(
          `${request.cwd}/target/${TARGET}/release/bundle/macos/Demo App.app/Contents/MacOS/demo`,
          'bin',
        );
      }
      return code;
    },
  };
  (fixture as { seams: BuildSeams }).seams = seams;
  return fixture;
}

function reportText(config: Record<string, unknown>, target = TARGET): string {
  const base = sampleBundleReport();
  return serializeBundleReport({
    ...base,
    target,
    product: {
      ...base.product,
      productId: config.productId as string,
      bundleId: config.bundleId as string,
      displayName: config.displayName as string,
    },
  });
}

export const APP = '/work/app';
export const BUNDLE = '/work/bundle';
export const OUT = '/work/out/installer';
