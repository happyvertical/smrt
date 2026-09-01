import type { RequestHandler } from './$types';

import { runtimeDiagnosticsGet } from '$lib/server/runtime-diagnostics';

export const GET: RequestHandler = runtimeDiagnosticsGet;
