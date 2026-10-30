import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parseAllDocuments } = require('yaml');

/** One validated chart identity for the package filename and its published tag. */
export function chartArtifact(chartDirectory, packageDirectory, registryEndpoint) {
  const documents = parseAllDocuments(readFileSync(join(chartDirectory, 'Chart.yaml'), 'utf8'));
  if (documents.length !== 1 || documents[0].errors.length) throw new Error('Invalid chart metadata');
  const metadata = documents[0].toJSON();
  if (metadata?.apiVersion !== 'v2' || metadata.name !== 'smrt-app' ||
      typeof metadata.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(metadata.version)) {
    throw new Error('Expected a versioned smrt-app v2 chart');
  }
  const registry = new URL(registryEndpoint);
  if (!['http:', 'https:'].includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash || registry.pathname !== '/') {
    throw new Error('Expected a credential-free registry origin');
  }
  const version = metadata.version;
  // Helm maps SemVer build metadata '+' to '_' in an OCI registry tag.
  const ociTag = version.replace('+', '_');
  return {
    version,
    ociTag,
    packagePath: join(packageDirectory, `smrt-app-${version}.tgz`),
    manifestUrl: `${registry.origin}/v2/charts/smrt-app/manifests/${ociTag}`,
  };
}
