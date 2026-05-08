import type {
  AccountStatus,
  PublishMode,
  SocialPlatformType,
} from '../social-account.js';

export interface SocialAccountSettingsItem {
  id: string;
  name: string;
  platform: SocialPlatformType;
  platformUsername?: string | null;
  platformUrl?: string | null;
  isActive: boolean;
  status: AccountStatus;
  needsAttention?: boolean;
  missingPermissions?: string[];
  publishMode?: PublishMode;
  publicPublishingAllowed?: boolean;
  tokenExpiresAt?: Date | string | null;
}
