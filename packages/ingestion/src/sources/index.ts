export type { SourceBinding, SourceResult } from './common.js';
export type {
  EmailDelivery,
  EmailIntakeSnapshot,
  EmailSourceOptions,
} from './email.js';
export { EmailSourceAdapter } from './email.js';
export type {
  AuthenticatedSource,
  SourceHttpOptions,
  VerifiedVendorDelivery,
} from './http.js';
export {
  createSourceDeliveryHandler,
  createVendorWebhookHandler,
} from './http.js';
export type { WatchFolderOptions, WatchFolderResult } from './watch-folder.js';
export { WatchFolderSourceAdapter } from './watch-folder.js';
