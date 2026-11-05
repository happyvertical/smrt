import type { DatabaseInterface } from '@happyvertical/sql';

const deviceIds = new WeakMap<DatabaseInterface, string>();

/** Configure the identity used for local tracked writes on this database handle. */
export function setDatabaseSyncDeviceId(
  db: DatabaseInterface,
  deviceId: string,
): void {
  if (
    typeof deviceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      deviceId,
    )
  ) {
    throw new TypeError('The sync device ID must be a UUID');
  }
  deviceIds.set(db, deviceId.toLowerCase());
}

export function getDatabaseSyncDeviceId(
  db: DatabaseInterface,
): string | undefined {
  return deviceIds.get(db);
}

export function inheritDatabaseSyncDeviceId(
  db: DatabaseInterface,
  bound: DatabaseInterface,
): void {
  const deviceId = getDatabaseSyncDeviceId(db);
  if (deviceId !== undefined) deviceIds.set(bound, deviceId);
}
