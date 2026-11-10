// The smrt() plugin scans `objectsDir` for the shell's own models. A wrong
// directory builds fine and silently registers none of them, so the build
// checks the manifest it just wrote.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The shell's own models: the manifest must list every one. */
export const SHELL_MODELS = [
  'App',
  'AppVersion',
  'Approval',
  'AssistantThread',
  'AssistantMessage',
] as const;

/** Names in `SHELL_MODELS` that the manifest does not describe. */
export function missingShellModels(manifest: unknown): string[] {
  const objects = (manifest as { objects?: Record<string, unknown> } | null)
    ?.objects;
  const have = new Set(
    Object.entries(objects ?? {}).map(([key, value]) => {
      const className = (value as { className?: string } | undefined)
        ?.className;
      return className ?? key.split(':').pop() ?? key;
    }),
  );
  return SHELL_MODELS.filter((name) => !have.has(name));
}

/** Throws when `<root>/.smrt/manifest.json` lacks a shell model. */
export function assertShellManifest(root: string): void {
  const file = join(root, '.smrt', 'manifest.json');
  if (!existsSync(file)) {
    throw new Error(`smrt manifest not found at ${file}`);
  }
  const missing = missingShellModels(JSON.parse(readFileSync(file, 'utf8')));
  if (missing.length > 0) {
    throw new Error(
      `the smrt manifest lacks the shell models ${missing.join(', ')}: check objectsDir in vite.config.ts`,
    );
  }
}

/** A Vite plugin that runs the check once a build has written the manifest. */
export function shellManifestGuard(root: string) {
  return {
    name: 'smrt-app-shell:manifest-guard',
    apply: 'build' as const,
    enforce: 'post' as const,
    closeBundle() {
      assertShellManifest(root);
    },
  };
}
