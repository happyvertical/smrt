/**
 * Application identity, private state root, and operator-artifact path
 * custody for the `smrt app` command group.
 *
 * Identity, configuration fingerprint, and the private state root are
 * `@happyvertical/smrt-app-runtime`'s single implementation (re-exported
 * here), so the running web process and these commands can never derive
 * different identities or lock domains. Operator-artifact path custody is
 * CLI-only and stays here.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export {
  type ApplicationStateRootOptions,
  type FingerprintRuntime,
  prepareApplicationStateRoot,
  type ResolveApplicationIdOptions,
  resolveApplicationId,
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
  type StateCustodyOptions,
} from '@happyvertical/smrt-app-runtime';

function isInside(parent: string, child: string): boolean {
  const relative = child.slice(parent.length);
  return (
    child === parent ||
    (child.startsWith(parent) &&
      (relative.startsWith('/') || relative.startsWith('\\')))
  );
}

/** Inputs for {@link assertExternalArtifactPath}. */
export interface ExternalArtifactPathOptions {
  sourceRoot: string;
  path: string;
  /** Message label, e.g. `Backup destination`. Defaults to `Artifact`. */
  label?: string;
}

/**
 * Resolve an operator-selected artifact through its nearest existing ancestor
 * and reject paths that could place application data in or over the checkout.
 */
export function assertExternalArtifactPath(
  options: ExternalArtifactPathOptions,
): string {
  const canonicalSource = realpathSync(resolve(options.sourceRoot));
  const missingSegments: string[] = [];
  let existingAncestor = resolve(options.path);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalPath = resolve(
    realpathSync(existingAncestor),
    ...missingSegments,
  );
  if (
    isInside(canonicalSource, canonicalPath) ||
    isInside(canonicalPath, canonicalSource)
  ) {
    throw new Error(
      `${options.label || 'Artifact'} must remain outside the source tree.`,
    );
  }
  return canonicalPath;
}
