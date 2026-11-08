/** Package-private shared metadata storage; preserve the existing cross-entry/global identity. */
import type { PermissionDefinition } from './permission-registry.js';

declare global {
  // eslint-disable-next-line no-var
  var __smrtUsersPermissionRegistrations:
    | Map<number, PermissionDefinition[]>
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtUsersPermissionRegistrationCounter: number | undefined;
}

export function getRuntimePermissionRegistrations(): Map<
  number,
  PermissionDefinition[]
> {
  globalThis.__smrtUsersPermissionRegistrations ??= new Map<
    number,
    PermissionDefinition[]
  >();
  return globalThis.__smrtUsersPermissionRegistrations;
}
