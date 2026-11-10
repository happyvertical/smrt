// Helpers for `+layout.server.ts` / `+page.server.ts`: read the shell's own
// JSON routes with the request's cookies (SvelteKit's `event.fetch`), so the
// owner check stays in one place (the routes).
import { error } from '@sveltejs/kit';
import { ApiError, api } from './api.ts';
import { referencedModels } from './columns.ts';
import type { Description, FieldDef, RecordRow } from './types.ts';

type Fetch = typeof fetch;

/** Load an API result; a failure becomes a SvelteKit error with its message. */
export async function load<T>(fetchImpl: Fetch, path: string): Promise<T> {
  try {
    return (await api<T>(path, { fetch: fetchImpl })).data;
  } catch (e) {
    if (e instanceof ApiError)
      error(e.status >= 400 ? e.status : 502, e.message);
    throw e;
  }
}

export type DescribeResult =
  | { ok: true; description: Description }
  | { ok: false; status: number };

/** The app description, or why there is none (signed out / not the owner). */
export async function loadDescription(
  fetchImpl: Fetch,
): Promise<DescribeResult> {
  try {
    const { data } = await api<Description>('/api/shell/describe', {
      fetch: fetchImpl,
    });
    return { ok: true, description: data };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403))
      return { ok: false, status: e.status };
    if (e instanceof ApiError)
      error(e.status >= 400 ? e.status : 502, e.message);
    throw e;
  }
}

export async function loadRecords(
  fetchImpl: Fetch,
  model: string,
  limit = 500,
): Promise<RecordRow[]> {
  const out = await load<{ records: RecordRow[] }>(
    fetchImpl,
    `/api/shell/records/${encodeURIComponent(model)}?limit=${limit}`,
  );
  return out.records;
}

/** Records of every model the given fields point at. */
export async function loadReferences(
  fetchImpl: Fetch,
  fields: Record<string, FieldDef>,
  known: Description['models'],
): Promise<Record<string, RecordRow[]>> {
  const names = referencedModels(fields).filter((m) => Object.hasOwn(known, m));
  const rows = await Promise.all(names.map((m) => loadRecords(fetchImpl, m)));
  return Object.fromEntries(names.map((m, i) => [m, rows[i]]));
}

/** The description for an owner-only page, or a 401. */
export function needOwner(description: Description | null): Description {
  if (!description) error(401, 'Sign in as the owner to use this page.');
  return description;
}

/** The named model of the description, or a 404. */
export function needModel(description: Description, name: string) {
  if (!Object.hasOwn(description.models, name))
    error(404, `This app has no "${name}" model.`);
  return description.models[name];
}
