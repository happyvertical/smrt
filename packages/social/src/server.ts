import type {
  LinkBehavior,
  PublishMode,
  SocialPlatformType,
} from './social-account.js';

export type SocialAccountSetupMethod = 'oauth' | 'manual';

export interface SocialPlatformSetup {
  platform: SocialPlatformType;
  label: string;
  setupMethod: SocialAccountSetupMethod;
  postTypes: Array<'text' | 'link' | 'image' | 'video'>;
  defaultLinkBehavior: LinkBehavior;
  defaultPublishMode: PublishMode;
  supportedPublishModes: PublishMode[];
  requiredSecretFields: string[];
}

export const SOCIAL_PLATFORM_SETUPS: SocialPlatformSetup[] = [
  {
    platform: 'youtube',
    label: 'YouTube',
    setupMethod: 'oauth',
    postTypes: ['video'],
    defaultLinkBehavior: 'description',
    defaultPublishMode: 'private_or_scheduled',
    supportedPublishModes: ['dry_run', 'private_or_scheduled', 'public'],
    requiredSecretFields: ['clientId', 'clientSecret', 'accessToken'],
  },
  {
    platform: 'facebook',
    label: 'Facebook Page',
    setupMethod: 'oauth',
    postTypes: ['text', 'link', 'image', 'video'],
    defaultLinkBehavior: 'attachment',
    defaultPublishMode: 'private_or_scheduled',
    supportedPublishModes: [
      'dry_run',
      'stage_remote',
      'private_or_scheduled',
      'public',
    ],
    requiredSecretFields: ['accessToken', 'pageId'],
  },
  {
    platform: 'threads',
    label: 'Threads',
    setupMethod: 'oauth',
    postTypes: ['text', 'link', 'image', 'video'],
    defaultLinkBehavior: 'attachment',
    defaultPublishMode: 'stage_remote',
    supportedPublishModes: ['dry_run', 'stage_remote', 'public'],
    requiredSecretFields: ['accessToken', 'userId'],
  },
  {
    platform: 'x',
    label: 'X',
    setupMethod: 'oauth',
    postTypes: ['text', 'link', 'image', 'video'],
    defaultLinkBehavior: 'inline',
    defaultPublishMode: 'dry_run',
    supportedPublishModes: ['dry_run', 'stage_remote', 'public'],
    requiredSecretFields: [
      'apiKey',
      'apiSecret',
      'accessToken',
      'accessSecret',
    ],
  },
  {
    platform: 'bluesky',
    label: 'Bluesky',
    setupMethod: 'manual',
    postTypes: ['text', 'link', 'image'],
    defaultLinkBehavior: 'attachment',
    defaultPublishMode: 'dry_run',
    supportedPublishModes: ['dry_run', 'stage_remote', 'public'],
    requiredSecretFields: ['identifier', 'password'],
  },
];

export function getSocialPlatformSetup(
  platform: SocialPlatformType,
): SocialPlatformSetup {
  const setup = SOCIAL_PLATFORM_SETUPS.find(
    (item) => item.platform === platform,
  );
  if (!setup) {
    throw new Error(`Unsupported social platform: ${platform}`);
  }
  return setup;
}

export function getDefaultSocialAccountName(
  platform: SocialPlatformType,
  username?: string | null,
): string {
  const setup = getSocialPlatformSetup(platform);
  return username ? `${setup.label} ${username}` : setup.label;
}

export function normalizeManualCredentials(
  platform: SocialPlatformType,
  values: Record<string, unknown>,
): Record<string, string> {
  const setup = getSocialPlatformSetup(platform);
  const credentials: Record<string, string> = {};

  for (const field of setup.requiredSecretFields) {
    const value = values[field];
    if (typeof value === 'string' && value.trim() !== '') {
      credentials[field] = value.trim();
    }
  }

  return credentials;
}
