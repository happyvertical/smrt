
import { ManifestBuilder } from '@happyvertical/smrt-core/manifest';

async function run() {
  const builder = new ManifestBuilder();
  await builder.generate({
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.d.ts'],
    baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection', 'Agent'],
    followImports: true,
    discoverExternalPackages: true,
    includeExternalBaseClasses: true,
    outputDir: 'src/manifest',
    outputName: 'test-manifest.json',
    generateTypeStub: true,
    stubName: 'test-manifest-stub.ts',
    injectPackageInfo: true,
  });
}

run().catch(console.error);
