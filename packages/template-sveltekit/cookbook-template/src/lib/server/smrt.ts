import { createCookbookApplication } from '@happyvertical/smrt-template-sveltekit/host/server';
import { activationLoaders, activationManifest } from './smrt-register';
import { name } from '../../../package.json';
import './settings-registry';

export const host = createCookbookApplication({
  packageName: name,
  lazyActivation: { manifest: activationManifest, loaders: activationLoaders, scope: name },
});
export const runtime = host.runtime;
