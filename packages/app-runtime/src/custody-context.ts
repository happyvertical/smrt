/**
 * Ambient platform and Windows runtime for the custody code.
 *
 * Production never sets anything: the context is the real platform and the real
 * Windows runtime. Tests run a callback under {@link runWithCustodyContext} to
 * exercise the Windows rule on any host with a fake runtime. This module is
 * internal (not exported from the package), and the seam is deliberately not an
 * option on any public function: an injectable ACL inspector in a public
 * option would be a way to switch custody off.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { platform } from 'node:os';
import {
  createNodeWindowsRuntime,
  type WindowsCustodyRuntime,
} from './windows-custody.js';

export interface CustodyContext {
  readonly platform: NodeJS.Platform;
  readonly windows: WindowsCustodyRuntime;
}

const storage = new AsyncLocalStorage<CustodyContext>();
let defaultWindows: WindowsCustodyRuntime | undefined;

/** The context in force: a test override, else the real platform and runtime. */
export function custodyContext(): CustodyContext {
  const override = storage.getStore();
  if (override) return override;
  defaultWindows ??= createNodeWindowsRuntime();
  return { platform: platform(), windows: defaultWindows };
}

/** Run `action` (sync or async) with the given context. Test seam. */
export function runWithCustodyContext<T>(
  context: CustodyContext,
  action: () => T,
): T {
  return storage.run(context, action);
}
