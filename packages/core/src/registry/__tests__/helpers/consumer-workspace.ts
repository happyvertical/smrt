/**
 * On-disk consumer workspaces for registry identity tests (#3106, #3109,
 * #3110).
 *
 * Class identity is derived from where a class is declared: the nearest
 * `package.json` above the declaring file, and the manifests that describe that
 * file. These fixtures lay a consumer's workspace out on disk so the real stack
 * walks and manifest lookups run against it: an app with its own manifest,
 * workspace packages whose sources the app scans, installed dependencies
 * (including pnpm peer-variant copies), and bundled build output.
 *
 * Fixture modules do not import smrt-core (nothing resolves from a temp
 * directory); each exports `define({ smrt, SmrtObject })`, which applies the
 * decorator inside the fixture file so the registration's stack names it.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ConsumerWorkspace {
  root: string;
  path: (...segments: string[]) => string;
  write: (relativePath: string, content: string) => string;
  writePackage: (relativeDir: string, name: string) => void;
  /** A fixture module declaring one class via `define({ smrt, SmrtObject })`. */
  writeModel: (
    relativePath: string,
    className: string,
    config?: Record<string, unknown>,
  ) => string;
  dispose: () => void;
}

export function createConsumerWorkspace(prefix: string): ConsumerWorkspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  const path = (...segments: string[]) => join(root, ...segments);
  const write = (relativePath: string, content: string) => {
    const file = path(relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  write(
    'package.json',
    JSON.stringify({ name: 'fixture-root', private: true }),
  );
  write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  return {
    root,
    path,
    write,
    writePackage: (relativeDir, name) => {
      write(join(relativeDir, 'package.json'), JSON.stringify({ name }));
    },
    writeModel: (relativePath, className, config = {}) =>
      write(
        relativePath,
        [
          'export function define({ smrt, SmrtObject }) {',
          `  return smrt(${JSON.stringify(config)})(class ${className} extends SmrtObject {});`,
          '}',
          '',
        ].join('\n'),
      ),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A manifest entry as an app's scanner writes it. */
export function manifestEntry(options: {
  className: string;
  packageName: string;
  filePath: string;
  tableName: string;
  fields: Record<string, { type: string }>;
}) {
  const { className, packageName, filePath, tableName, fields } = options;
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    packageName,
    filePath,
    extends: 'SmrtObject',
    fields,
    methods: {},
    decoratorConfig: { tableName },
    schema: {
      tableName,
      ddl: '',
      columns: {},
      indexes: [],
      version: 'fixture',
    },
  };
}
