/**
 * `smrt kitchen [dir]` (#3750): find the planner, serve it on localhost, let
 * the visitor chat their way to a cookbook, apply what they send into `dir`.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COOKBOOK_CONFIG_FILE } from '../cookbook/apply.js';
import { type KitchenAI, resolveKitchenAI } from './ai.js';
import {
  type AppliedBody,
  type CookbookApplier,
  createCookbookApplier,
} from './apply.js';
import {
  loadPlannerCore,
  type PlannerCore,
  PlannerError,
  type PlannerInstall,
  resolvePlanner,
} from './planner.js';
import { type KitchenServer, startKitchenServer } from './server.js';

export interface KitchenRunOptions {
  /** Project directory. */
  dir: string;
  /** `--planner`: a packaged planner directory. */
  planner?: string;
  template?: string;
  install: boolean;
  open: boolean;
  manifests?: string[];
  registry: boolean;
  port?: number;
  log?: (line: string) => void;
  /** Called once the server is listening (tests read the URL and token here). */
  onReady?: (server: KitchenServer) => void;
  /** Replace the pieces that touch the outside world (tests). */
  overrides?: {
    planner?: PlannerInstall;
    core?: PlannerCore;
    ai?: KitchenAI | null;
    apply?: CookbookApplier;
    token?: string;
    openBrowser?: (url: string) => void;
  };
  /** Rejecting this stops the kitchen (the CLI wires Ctrl-C to it). */
  stop?: Promise<never>;
}

/** The target must be new (absent or empty) or an existing kitchen project. */
export function checkTargetDir(dir: string): void {
  if (!existsSync(dir) || readdirSync(dir).length === 0) return;
  if (
    existsSync(join(dir, COOKBOOK_CONFIG_FILE)) &&
    existsSync(join(dir, 'package.json'))
  ) {
    return;
  }
  throw new PlannerError(
    `${dir} is not empty and holds no ${COOKBOOK_CONFIG_FILE}; pick an empty directory (smrt kitchen <dir>)`,
  );
}

export function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command, args, { windowsHide: true }, () => {
    // No browser to open: the URL is printed, the user can paste it.
  });
}

/** Run the kitchen until a cookbook was applied. Returns what was written. */
export async function runKitchen(
  options: KitchenRunOptions,
): Promise<AppliedBody> {
  const log = options.log ?? console.log;
  const dir = resolve(options.dir);
  checkTargetDir(dir);

  const planner =
    options.overrides?.planner ??
    (await resolvePlanner({ planner: options.planner, dir, log }));
  const core = options.overrides?.core ?? (await loadPlannerCore(planner));
  const ai =
    options.overrides && 'ai' in options.overrides
      ? (options.overrides.ai ?? null)
      : await resolveKitchenAI({ dir });

  const server = await startKitchenServer({
    planner,
    core,
    ai,
    apply:
      options.overrides?.apply ??
      createCookbookApplier({
        dir,
        template: options.template,
        install: options.install,
        manifests: options.manifests,
        registry: options.registry,
        log,
      }),
    port: options.port,
    token: options.overrides?.token,
    log,
  });
  try {
    log(
      `Planner ${planner.version ?? ''} (${planner.source}) at ${server.url}`.replace(
        '  ',
        ' ',
      ),
    );
    log(
      ai
        ? `Chat is answered by ${ai.label}.`
        : 'No AI provider is configured (set an `ai` block in smrt.config.ts, SMRT_AI_PROVIDER, or e.g. OPENAI_API_KEY), so the planner runs its in-browser model. You can also build the cookbook by hand.',
    );
    log(`Project directory: ${dir}`);
    log(
      'Build your app in the planner, then choose "Send to kitchen". Ctrl-C to stop.',
    );
    options.onReady?.(server);
    if (options.open)
      (options.overrides?.openBrowser ?? openInBrowser)(server.url);
    return await (options.stop
      ? Promise.race([server.applied, options.stop])
      : server.applied);
  } finally {
    await server.close();
  }
}
