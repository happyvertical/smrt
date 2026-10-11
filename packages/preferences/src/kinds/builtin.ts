/**
 * Registers the built-in preference kinds (`overview`, `shell-layout`) once.
 * Imported by the package entry and the store, so the model never meets a
 * built-in kind it does not know.
 */
import { getPreferenceKind, registerPreferenceKind } from '../kinds.js';
import { overviewPreferenceKind } from './overview.js';
import { shellLayoutPreferenceKind } from './shell-layout.js';

export function ensureBuiltinPreferenceKinds(): void {
  for (const kind of [overviewPreferenceKind, shellLayoutPreferenceKind]) {
    if (!getPreferenceKind(kind.kind)) registerPreferenceKind(kind);
  }
}

ensureBuiltinPreferenceKinds();
