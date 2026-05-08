import type { ComponentProps } from 'svelte';

import SocialAccountSettings from './components/SocialAccountSettings.svelte';

export { SocialAccountSettings };
export type SocialAccountSettingsProps = ComponentProps<
  typeof SocialAccountSettings
>;
export type { SocialAccountSettingsItem } from './types.js';
