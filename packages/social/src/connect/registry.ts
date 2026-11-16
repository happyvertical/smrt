import type { SocialPlatformType } from '../social-account.js';
import type { SocialConnectProvider } from './types.js';
import { xConnectProvider } from './x.js';

const providers = new Map<SocialPlatformType, SocialConnectProvider>([
  [xConnectProvider.platform, xConnectProvider],
]);

/** Register (or replace) a provider. Hosts can add platforms without a release. */
export function registerSocialConnectProvider(
  provider: SocialConnectProvider,
): void {
  providers.set(provider.platform, provider);
}

export function getSocialConnectProvider(
  platform: string,
): SocialConnectProvider | undefined {
  return providers.get(platform as SocialPlatformType);
}

export function listSocialConnectProviders(): SocialConnectProvider[] {
  return [...providers.values()];
}
