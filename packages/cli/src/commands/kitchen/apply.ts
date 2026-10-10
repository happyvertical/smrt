/**
 * Applying a cookbook the page sent to `smrt kitchen` (#3750): the same
 * validation and apply engine as `smrt cookbook apply`, wrapped as one call
 * that returns the HTTP-shaped outcome the planner shows to the visitor.
 */

import {
  ApplyError,
  type ApplyResult,
  applyCookbook,
} from '../cookbook/apply.js';
import { cliVersion, validateCookbookSource } from '../cookbook/shared.js';

export interface ApplierOptions {
  /** The project directory (`smrt kitchen [dir]`). */
  dir: string;
  /** Project template (local path, `github:owner/repo[#ref]`, git URL). */
  template?: string;
  /** Run the package manager's install after writing. */
  install: boolean;
  manifests?: string[];
  /** Allow fetching manifests of uninstalled packages from the registry. */
  registry: boolean;
  /** Where progress goes (the terminal). */
  log?: (line: string) => void;
}

/** Body of a successful `POST /api/kitchen/cookbook`. */
export interface AppliedBody {
  ok: true;
  dir: string;
  mode: 'new' | 'update';
  installed: boolean;
  added: string[];
  nextSteps: string[];
}

export type ApplyOutcome =
  | { ok: true; status: 200; body: AppliedBody; result: ApplyResult }
  | { ok: false; status: number; errors: string[] };

export type CookbookApplier = (text: string) => Promise<ApplyOutcome>;

export function createCookbookApplier(
  options: ApplierOptions,
): CookbookApplier {
  const log = options.log ?? (() => {});
  return async (text) => {
    let cookbookText = text;
    try {
      // Normalise: the page sends JSON; reject anything else early.
      cookbookText = JSON.stringify(JSON.parse(text));
    } catch {
      return {
        ok: false,
        status: 400,
        errors: ['The body is not valid JSON.'],
      };
    }
    try {
      log('Checking the cookbook against the recipe manifests…');
      const report = await validateCookbookSource(cookbookText, {
        dir: options.dir,
        manifests: options.manifests,
        registry: options.registry,
      });
      for (const warning of report.warnings) log(`warning: ${warning}`);
      if (!report.ok || !report.cookbook) {
        return { ok: false, status: 422, errors: report.errors };
      }
      log(`Writing the project in ${options.dir}…`);
      const result = applyCookbook({
        cookbook: report.cookbook,
        packages: report.packages,
        dir: options.dir,
        template: options.template,
        install: options.install,
        cliVersion: cliVersion(),
      });
      return {
        ok: true,
        status: 200,
        result,
        body: {
          ok: true,
          dir: result.plan.targetDir,
          mode: result.plan.mode,
          installed: result.installed,
          added: Object.keys(result.plan.addDependencies),
          nextSteps: result.nextSteps,
        },
      };
    } catch (error) {
      if (error instanceof ApplyError) {
        return { ok: false, status: 409, errors: [error.message] };
      }
      return {
        ok: false,
        status: 500,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  };
}
