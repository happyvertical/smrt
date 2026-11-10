// Inference settings, owner only. Every action runs as the verified owner
// (`asOwner` refuses a member or a stranger before a body is read); the load
// and the writes are smrt-inference's shared controller. No key ever comes
// back: the page learns only whether one is stored.
import type { InferenceSettingsOutcome } from '@happyvertical/smrt-inference/server';
import { error, fail } from '@sveltejs/kit';
import { asOwner, shellInferenceController } from '$lib/server/inference';
import { PolicyError } from '$lib/server/owner';
import type { Actions, PageServerLoad } from './$types';

type Controller = ReturnType<typeof shellInferenceController>;
type Locals = Parameters<typeof asOwner>[0];
type OwnerRun<T> = Parameters<typeof asOwner<T>>[1];

/** The page's action result for a controller outcome. */
function result(outcome: InferenceSettingsOutcome<Record<string, unknown>>) {
  return outcome.ok ? outcome : fail(outcome.status, { error: outcome.error });
}

/** Run as the owner; a refusal is a 401/403 page error with no detail. */
async function owned<T>(locals: Locals, run: OwnerRun<T>): Promise<T> {
  try {
    return await asOwner(locals, run);
  } catch (cause) {
    if (cause instanceof PolicyError) error(cause.status, cause.message);
    throw cause;
  }
}

/** The JSON `payload` form field the settings client posts. */
async function readPayload(request: Request): Promise<unknown> {
  const form = await request.formData();
  const raw = form.get('payload');
  if (typeof raw !== 'string') error(400, 'Missing payload');
  try {
    return JSON.parse(raw);
  } catch {
    error(400, 'Invalid payload');
  }
}

export const load: PageServerLoad = ({ locals, url, depends }) => {
  depends('smrt:inference-settings');
  return owned(locals, (_owner, session) =>
    shellInferenceController().load(session, url.searchParams.get('by')),
  );
};

type Writer = (
  session: never,
  payload: never,
) => Promise<InferenceSettingsOutcome<Record<string, unknown>>>;

/** One action: as the owner, parse the payload, then call the controller. */
function action(
  name: Exclude<keyof Controller, 'canCustomize' | 'load' | 'discoverModels'>,
) {
  return ({ request, locals }: { request: Request; locals: Locals }) =>
    owned(locals, async (_owner, session) => {
      const payload = await readPayload(request);
      const write = shellInferenceController()[name] as unknown as Writer;
      return result(await write(session as never, payload as never));
    });
}

export const actions: Actions = {
  saveDefaults: action('saveDefaults'),
  // The key is stored through the user resolver (as the
  // `inference.provider-config` secret) and never comes back to the browser.
  saveKey: action('saveKey'),
  saveTier: action('saveTier'),
  saveDefaultTier: action('saveDefaultTier'),
  saveAlias: action('saveAlias'),
  saveFusion: action('saveFusion'),
  saveTranscripts: action('saveTranscripts'),
  // Probes return a key-free result; they write nothing.
  testConnection: action('testConnection'),
  testCandidate: action('testCandidate'),
  discoverModels: ({ locals }) =>
    owned(locals, (_owner, session) =>
      shellInferenceController().discoverModels(session),
    ),
};
