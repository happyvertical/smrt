import { validReportResult } from './result.js';
import { runtimeReportSpecFromWire } from './spec.js';
import type {
  RuntimeReportResult,
  RuntimeReportsClient,
  SavedRuntimeReport,
} from './types.js';

export interface RuntimeReportsHttpClientOptions {
  fetch?: typeof globalThis.fetch;
  basePath?: string;
  currentUserId?: string;
  /** UI capability hint only. The server remains authoritative. */
  canArchive?:
    | boolean
    | ((report: Omit<SavedRuntimeReport, 'canArchive'>) => boolean);
}

export class RuntimeReportsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super('Runtime report request failed');
    this.name = 'RuntimeReportsHttpError';
  }
}

const REPORT_LIST_PAGE_LIMIT = 1_000;
const MAX_REPORT_LIST_PAGES = 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function responseJson(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RuntimeReportsHttpError(response.status);
  }
  if (!response.ok) {
    const data = record(body);
    throw new RuntimeReportsHttpError(
      response.status,
      typeof data?.code === 'string' ? data.code : undefined,
    );
  }
  return body;
}

function safeId(value: string): string {
  return encodeURIComponent(value);
}

function confirmUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new RuntimeReportsHttpError(400, 'invalid_confirm_path');
  if (typeof location === 'undefined') return path;
  const url = new URL(path, location.href);
  if (url.origin !== location.origin)
    throw new RuntimeReportsHttpError(400, 'invalid_confirm_path');
  return `${url.pathname}${url.search}`;
}

export function createRuntimeReportsHttpClient(
  options: RuntimeReportsHttpClientOptions = {},
): RuntimeReportsClient {
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== 'function')
    throw new Error('Runtime reports require a fetch implementation');
  const basePath = (options.basePath ?? '/api/runtimereports').replace(
    /\/$/,
    '',
  );
  const lastRuns = new Map<string, string>();

  const project = (value: unknown): SavedRuntimeReport => {
    const row = record(value);
    if (!row) throw new RuntimeReportsHttpError(502, 'invalid_result');
    const spec = runtimeReportSpecFromWire(row.spec);
    if (
      !spec ||
      typeof row.id !== 'string' ||
      typeof row.title !== 'string' ||
      typeof row.sourceId !== 'string' ||
      typeof row.createdByUserId !== 'string' ||
      (row.status !== 'active' && row.status !== 'archived')
    ) {
      throw new RuntimeReportsHttpError(502, 'invalid_result');
    }
    const projected: Omit<SavedRuntimeReport, 'canArchive'> = {
      id: row.id,
      title: row.title,
      ...(typeof row.description === 'string' && row.description
        ? { description: row.description }
        : {}),
      sourceId: row.sourceId,
      createdByUserId: row.createdByUserId,
      status: row.status,
      spec,
      ...(lastRuns.has(row.id) ? { lastRunAt: lastRuns.get(row.id) } : {}),
    };
    const canArchive =
      typeof options.canArchive === 'function'
        ? options.canArchive(projected)
        : options.canArchive === true;
    return { ...projected, canArchive };
  };

  const get = async (id: string): Promise<SavedRuntimeReport> =>
    project(
      await responseJson(
        await request(`${basePath}/${safeId(id)}`, {
          headers: { accept: 'application/json' },
        }),
      ),
    );

  return {
    async list({ onlyMine, includeArchived }) {
      const filters = new URLSearchParams();
      if (!includeArchived) filters.set('status', 'active');
      if (onlyMine) {
        if (!options.currentUserId)
          throw new RuntimeReportsHttpError(400, 'missing_current_user');
        filters.set('createdByUserId', options.currentUserId);
      }

      const reports: SavedRuntimeReport[] = [];
      let offset = 0;
      for (let page = 0; page < MAX_REPORT_LIST_PAGES; page++) {
        const query = new URLSearchParams(filters);
        query.set('limit', String(REPORT_LIST_PAGE_LIMIT));
        query.set('offset', String(offset));
        const body = record(
          await responseJson(
            await request(`${basePath}?${query}`, {
              headers: { accept: 'application/json' },
            }),
          ),
        );
        if (
          !body ||
          !Array.isArray(body.items) ||
          typeof body.count !== 'number' ||
          !Number.isSafeInteger(body.count) ||
          body.count < 0 ||
          typeof body.limit !== 'number' ||
          !Number.isSafeInteger(body.limit) ||
          body.limit < 1 ||
          body.limit > REPORT_LIST_PAGE_LIMIT ||
          typeof body.offset !== 'number' ||
          !Number.isSafeInteger(body.offset) ||
          body.offset !== offset ||
          body.items.length > body.limit
        ) {
          throw new RuntimeReportsHttpError(502, 'invalid_result');
        }
        reports.push(...body.items.map(project));
        offset += body.items.length;
        if (offset >= body.count) return reports;
        if (body.items.length === 0)
          throw new RuntimeReportsHttpError(502, 'invalid_result');
      }
      throw new RuntimeReportsHttpError(502, 'invalid_result');
    },
    get,
    async run(id): Promise<RuntimeReportResult> {
      const body = record(
        await responseJson(
          await request(`${basePath}/${safeId(id)}/run`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          }),
        ),
      );
      if (body?.action !== 'run' || !validReportResult(body.result))
        throw new RuntimeReportsHttpError(502, 'invalid_result');
      lastRuns.set(id, body.result.ranAt);
      return body.result;
    },
    async archive(id, archived) {
      const body = record(
        await responseJson(
          await request(`${basePath}/${safeId(id)}/archive`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ archived }),
          }),
        ),
      );
      const result = record(body?.result);
      if (
        body?.action !== 'archive' ||
        result?.id !== id ||
        result.status !== (archived ? 'archived' : 'active')
      )
        throw new RuntimeReportsHttpError(502, 'invalid_result');
    },
    async confirm(proposal) {
      const body = record(
        await responseJson(
          await request(confirmUrl(proposal.confirmPath), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              spec: proposal.spec,
              specHash: proposal.specHash,
            }),
          }),
        ),
      );
      if (typeof body?.id !== 'string' || body.specHash !== proposal.specHash)
        throw new RuntimeReportsHttpError(502, 'invalid_result');
      return get(body.id);
    },
  };
}
