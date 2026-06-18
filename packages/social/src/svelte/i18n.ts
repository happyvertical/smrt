/**
 * smrt-social UI message catalog (S13 #1418).
 * Keys: `social.<component>.<descriptor>`.
 */
import { defineMessages } from '@happyvertical/smrt-svelte/i18n';

export const M = defineMessages({
  'social.account_settings.heading': 'Social Accounts',
  // Separate singular/plural messages so each locale supplies its own forms
  // (an English `{plural}` suffix does not translate). Selected by count below.
  'social.account_settings.configured_one': '{count} account configured',
  'social.account_settings.configured_other': '{count} accounts configured',
  'social.account_settings.connect_aria': 'Connect social account',
  'social.account_settings.loading': 'Loading accounts...',
  'social.account_settings.empty': 'No social accounts are configured yet.',
});
