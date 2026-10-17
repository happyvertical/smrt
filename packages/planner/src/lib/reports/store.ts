/**
 * Runtime reports over the planner's sample data (#4100): the browser
 * equivalent of a generated app's report tools and its confirmed save.
 *
 * - `sources()` is `reports.runtime.sources`: the app's menu models.
 * - `define(intent)` is `reports.runtime.define` (preview): build the spec,
 *   validate it with smrt-reports' own parser and run a preview with its
 *   in-memory runner. It returns the same `awaiting_confirmation` proposal a
 *   generated app returns; nothing is saved.
 * - `save(proposal)` is the confirmed save (`saveRuntimeReport`): only a
 *   person's approval calls it. It re-parses the spec, checks the hash and
 *   runs it again against the current sources, then stores a RuntimeReport
 *   row in the plan's sample data.
 * - `client` is the `RuntimeReportsClient` smrt-reports' `SavedReports` and
 *   `ReportDetail` read: list, get, run (afresh, every time), archive.
 *
 * Sample data carries no principal, tenant or permission, so none of this is
 * an authority boundary; a generated app's server owns those.
 */

import {
  parseRuntimeReportSpec,
  RuntimeReportError,
  type RuntimeReportResult,
  type RuntimeReportSpec,
  runRuntimeReportInMemory,
  runtimeReportSpecDigest,
  serializeRuntimeReportSpec,
} from '@happyvertical/smrt-reports/spec';
import type {
  RuntimeReportProposal,
  RuntimeReportsClient,
  SavedRuntimeReport,
} from '@happyvertical/smrt-reports/svelte';
import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogModel } from '../catalog/types.ts';
import type { DataSource, ModelRecord } from '../data/source.ts';
import type { Recipe } from '../recipes/types.ts';
import {
  questionForError,
  type ReportIntent,
  specFromIntent,
} from './intent.ts';
import {
  type PlannerReportSource,
  plannerReportSources,
  RUNTIME_REPORT_MODEL,
} from './sources.ts';

/** Who saves reports in the planner: there is one visitor and no accounts. */
export const PLANNER_REPORT_AUTHOR = 'planner';

/** Where a generated app's confirmation posts; recorded on the proposal as there. */
export const CONFIRM_PATH = '/api/_reports/runtime/confirm';

/** The in-app path of a saved report (the RuntimeReport record page). */
export function reportPath(id: string): string {
  return `/m/reports/RuntimeReport/${encodeURIComponent(id)}/`;
}

export interface PlannerReportsOptions {
  data: DataSource;
  /** The recipes that are on now; the sources follow them. */
  recipeIds: () => readonly string[];
  recipes: readonly Recipe[];
  /** The clock periods are relative to: the sample data's, so they hold rows. */
  now: () => Date;
}

export type DefineResult =
  | {
      ok: true;
      proposal: RuntimeReportProposal;
      source: PlannerReportSource;
    }
  | { ok: false; question: string };

export interface PlannerReports {
  sources(): PlannerReportSource[];
  define(intent: ReportIntent): Promise<DefineResult>;
  run(spec: RuntimeReportSpec): Promise<RuntimeReportResult>;
  save(proposal: RuntimeReportProposal): Promise<SavedRuntimeReport>;
  client: RuntimeReportsClient;
}

/** A refusal shaped like the HTTP client's, so the components word it the same. */
class PlannerReportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Report request failed (${code})`);
    this.name = 'PlannerReportError';
  }
}

function reportModel(): CatalogModel {
  const found = getModelByQualifiedName(RUNTIME_REPORT_MODEL);
  if (!found) throw new Error(`${RUNTIME_REPORT_MODEL} is not in the catalog`);
  return found.model;
}

/** A stored row as the browser projection; null when its spec no longer parses. */
function savedFrom(row: ModelRecord): SavedRuntimeReport | null {
  if (typeof row.spec !== 'string') return null;
  let spec: RuntimeReportSpec;
  try {
    spec = parseRuntimeReportSpec(row.spec);
  } catch {
    return null;
  }
  return {
    id: row.id,
    title: spec.title,
    ...(spec.description ? { description: spec.description } : {}),
    sourceId: spec.source,
    createdByUserId:
      typeof row.createdByUserId === 'string' ? row.createdByUserId : '',
    status: row.status === 'archived' ? 'archived' : 'active',
    spec,
    canArchive: true,
  };
}

export function createPlannerReports(
  options: PlannerReportsOptions,
): PlannerReports {
  const sources = () =>
    plannerReportSources(options.recipeIds(), options.recipes);

  /** `reports.runtime.run`: always against the sources and rows of now. */
  async function run(spec: RuntimeReportSpec): Promise<RuntimeReportResult> {
    const offered = sources();
    const source = offered.find((s) => s.id === spec.source);
    const rows = source ? await options.data.list(source.model) : [];
    return runRuntimeReportInMemory(spec, rows, {
      sources: offered,
      now: options.now,
    });
  }

  async function define(intent: ReportIntent): Promise<DefineResult> {
    const built = specFromIntent(intent, sources(), options.now());
    if (!built.ok) return built;
    try {
      const preview = await run(built.spec);
      return {
        ok: true,
        source: built.source,
        proposal: {
          status: 'awaiting_confirmation',
          specHash: preview.specHash,
          spec: built.spec,
          sourceLabel: built.source.label,
          confirmPath: CONFIRM_PATH,
          preview,
        },
      };
    } catch (error) {
      if (error instanceof RuntimeReportError) {
        return { ok: false, question: questionForError(error, built.source) };
      }
      throw error;
    }
  }

  async function rows(): Promise<SavedRuntimeReport[]> {
    const stored = await options.data.list(reportModel());
    return stored.flatMap((row) => savedFrom(row) ?? []).reverse();
  }

  async function find(id: string): Promise<SavedRuntimeReport> {
    const row = await options.data.get(reportModel(), id);
    const saved = row ? savedFrom(row) : null;
    if (!saved) throw new PlannerReportError(404, 'not_found');
    return saved;
  }

  /** The confirmed save. Recomputes everything; the proposal carries no authority. */
  async function save(
    proposal: RuntimeReportProposal,
  ): Promise<SavedRuntimeReport> {
    let spec: RuntimeReportSpec;
    try {
      spec = parseRuntimeReportSpec(proposal.spec);
    } catch {
      throw new PlannerReportError(422, 'invalid_spec');
    }
    const specHash = await runtimeReportSpecDigest(spec);
    if (specHash !== proposal.specHash) {
      throw new PlannerReportError(422, 'spec_hash_mismatch');
    }
    // As a server recompiles for the confirming principal: the source and
    // fields must still be offered now (a recipe may have been switched off).
    try {
      await run(spec);
    } catch (error) {
      if (error instanceof RuntimeReportError) {
        throw new PlannerReportError(422, error.code);
      }
      throw error;
    }
    const existing = (await rows()).find(
      (report) =>
        report.status === 'active' &&
        report.createdByUserId === PLANNER_REPORT_AUTHOR &&
        serializeRuntimeReportSpec(report.spec) ===
          serializeRuntimeReportSpec(spec),
    );
    if (existing) return existing; // A retry of the same approval saves once.
    const row = await options.data.create(reportModel(), {
      title: spec.title,
      description: spec.description ?? '',
      sourceId: spec.source,
      spec: serializeRuntimeReportSpec(spec),
      specHash,
      status: 'active',
      createdByUserId: PLANNER_REPORT_AUTHOR,
    });
    const saved = savedFrom(row);
    if (!saved) throw new PlannerReportError(500, 'invalid_result');
    return saved;
  }

  const client: RuntimeReportsClient = {
    async list({ onlyMine, includeArchived }) {
      return (await rows()).filter(
        (report) =>
          (includeArchived || report.status === 'active') &&
          (!onlyMine || report.createdByUserId === PLANNER_REPORT_AUTHOR),
      );
    },
    get: find,
    async run(id) {
      const report = await find(id);
      if (report.status === 'archived') {
        throw new PlannerReportError(409, 'report_archived');
      }
      return run(report.spec);
    },
    async archive(id, archived) {
      await find(id);
      await options.data.update(reportModel(), id, {
        status: archived ? 'archived' : 'active',
      });
    },
    confirm: save,
  };

  return { sources, define, run, save, client };
}
