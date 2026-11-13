/**
 * Registers the built-in preference kinds (`overview`, `shell-layout`) once.
 * Imported by the package entry and the store, so the model never meets a
 * built-in kind it does not know.
 */
import { getPreferenceKind, registerPreferenceKind } from '../kinds.js';
import { overviewPreferenceKind } from './overview.js';
import { prebuiltComponentsPreferenceKind } from './prebuilt-components.js';
import { shellLayoutPreferenceKind } from './shell-layout.js';
import { workProfilesPreferenceKind } from './work-profiles.js';

export function ensureBuiltinPreferenceKinds(): void {
  for (const kind of [
    workProfilesPreferenceKind,
    overviewPreferenceKind,
    shellLayoutPreferenceKind,
    prebuiltComponentsPreferenceKind,
  ]) {
    if (!getPreferenceKind(kind.kind)) registerPreferenceKind(kind);
  }
}

ensureBuiltinPreferenceKinds();
