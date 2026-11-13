/**
 * `POST /api/shell/draft/preview` (no body): what publishing the open draft
 * would do, from a rehearsal on a copy of the CURRENT live data (live is only
 * read; records changed since the draft started are kept, the draft's records
 * are not carried).
 * -> { draft: DraftInfo, preview: { digest, risky: true, fromVersion,
 *      toVersion, versions: { version, draftVersion, author, summary, steps,
 *      statements }[], definition: DefinitionDiff, archives: { values,
 *      tables }, methods: { model, name, status: 'added' | 'changed' |
 *      'unchanged', description, code, ... }[] } }
 * Pass `preview.digest` as `expect` to `POST /api/shell/draft/publish`.
 * Archive counts are of this moment and can drift. 404 no draft; 409 when the
 * draft cannot be published (see DraftInfo.problem).
 */

import { previewDraft } from '$lib/server/drafts';
import { guarded, json, ownerOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  return json(await previewDraft());
});
