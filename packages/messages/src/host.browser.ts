/** Browser boundary: ordinary model reads remain available, but private server authority and maintenance never fall back to browser globals. */
import type * as NodeHost from './host.js';

function serverRequired(): never {
  throw new Error('Messaging server operations require a server host.');
}
export const notificationSha256: typeof NodeHost.notificationSha256 =
  serverRequired;
export const canonicalNotificationMessageId: typeof NodeHost.canonicalNotificationMessageId =
  serverRequired;
export const isDeepStrictEqual: typeof NodeHost.isDeepStrictEqual =
  serverRequired;
export const buildSqliteRebuildStatements: typeof NodeHost.buildSqliteRebuildStatements =
  serverRequired;
export const assertNotificationMaintenanceHost: typeof NodeHost.assertNotificationMaintenanceHost =
  serverRequired;
/** No scope can be created or inherited in a browser. Absence is never authorization. */
export function createHandoffContext<T>(): NodeHost.HandoffContext<T> {
  return { getStore: () => undefined, run: serverRequired };
}

export const normalizeIdentityEmail: typeof NodeHost.normalizeIdentityEmail =
  serverRequired;
export const readNotificationProfile: typeof NodeHost.readNotificationProfile =
  serverRequired;

export const getCurrentTenant: typeof NodeHost.getCurrentTenant =
  serverRequired;
export const withTenant: typeof NodeHost.withTenant = serverRequired;
export const withSystemContext: typeof NodeHost.withSystemContext =
  serverRequired;
export const queryGlobal: typeof NodeHost.queryGlobal = serverRequired;
export const queryWithGlobals: typeof NodeHost.queryWithGlobals =
  serverRequired;

export const createAccountSecretService: typeof NodeHost.createAccountSecretService =
  serverRequired;
