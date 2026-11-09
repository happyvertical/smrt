# Inference settings

`@happyvertical/smrt-inference` ships an inference settings screen (#4754):
`InferenceSettingsPanel` on `./svelte` for the browser, and
`InferenceSettingsService` on `./server` for the load functions and actions
behind it. The panel is presentational; your host decides who may see and
change what.

## Where each setting lives

| Setting | Store | Written by |
| --- | --- | --- |
| API keys | smrt-secrets, as the #4756 `inference.provider-config` secret | the host's `onSaveKey` action: `bindInferenceKey()`, then `inferenceProviderConfigFromKey()` written through the user resolver's `write()` |
| Mode, provider, base URL, model, default tier (per user, tenant default) | smrt-preferences kind `inference` | `createInferencePreferences(store).write()` |
| Tier bindings, `auto`'s default tier, aliases, fusions (app and tenant) | `_smrt_inference_overrides` | `InferenceSettingsService` set methods (authorizer-gated) |
| Transcripts on/off, sample rate, byte cap (app only) | `_smrt_inference_overrides`, app row `transcripts` | `InferenceSettingsService.setTranscriptSettings()` (authorizer-gated) |

The split is enforced by the API shape. The panel hands a key out only
through `onSaveKey({ provider, key })` and never receives one back; it shows
"set" or "not set". Binding rows and preference payloads refuse any member
that looks like a credential. A key is bound to the origin of the endpoint
it was entered for, and the server sends it only to that origin.

## Minimal SvelteKit wiring

```ts
// +page.server.ts
import {
  bindInferenceKey,
  inferenceProviderConfigFromKey,
  createInferencePreferences,
  InferenceSettingsService,
} from '@happyvertical/smrt-inference/server';

export async function load({ locals }) {
  const settings = await InferenceSettingsService.create({ db: locals.db });
  const prefs = await createInferencePreferences(locals.preferenceStore).read();
  return {
    defaults: { ...prefs.choices, keySet: await locals.hasInferenceKey() },
    providers: settings.listProviderOptions(),
    tiers: await settings.listInferenceSettings({ tenantId: locals.tenantId }),
  };
}

export const actions = {
  saveKey: async ({ request, locals }) => {
    // The panel's onSaveKey change: { provider, key, preset?, baseUrl? }.
    // Bind to the endpoint the key was entered for, not to saved choices.
    const change = await request.json();
    const record = bindInferenceKey(change);
    // Store it once, as the #4756 provider config the user resolver reads
    // (`inference.provider-config`, user level; 'tenant' for a tenant key).
    await locals.inferenceResolver.write(
      'user',
      inferenceProviderConfigFromKey(record, { model: change.model }),
    );
  },
};
```

```svelte
<InferenceSettingsPanel {...data} onSaveKey={saveKey} onSaveDefaults={saveChoices} />
```

Register the preference kind and its permissions once at startup:
`registerPreferenceKind(inferencePreferenceKind)` and
`registerPermissionDefinitions([...INFERENCE_PERMISSION_DEFINITIONS])`.

## Tenant allow-list

A tenant may bind a tier only to a target on that tier's allow-list. The list
is stored on the app row (`setTenantAllowList`, e.g. `['alias:local',
'model:openai/*']`). With no list, tenants can bind nothing. The service's
`tenantTargetPolicy` option is the code half of the list, for example a cap
on the hosted tier a plan allows. Both halves are checked on every tenant
write and again on every read, so narrowing either one stops an existing
tenant binding from taking effect. Aliases and fusions are defined at the
app scope only, so a tenant cannot change what an allow-listed name means.

## Transcripts

Pass `transcripts: await settings.getTranscriptSettings()` and the panel
shows the app's transcript setting under Advanced: on or off, the success
sample rate, the byte cap, the retention window and which level set it.
Tenants cannot override it, so it is read-only unless the host also passes
`appEditable` (a platform admin) and `onSaveTranscripts`. Wire that callback
to an action that calls `setTranscriptSettings({ settings })`; it always
writes the app row (`null` reverts to config), asks your authorizer with
`{ binding: 'transcripts', scopeType: 'app' }`, and takes effect in that
process at once. `SMRT_INFERENCE_TRANSCRIPTS` still wins over the stored
value. Other processes pick it up through the override resolver within its
cache window; a worker that does not use the resolver calls
`loadInferenceTranscriptSettings({ db })` at startup. Retention is the
sweep's `retention.aiTranscripts.maxAgeDays` and is shown read-only.

In the Usage tab, build the report with
`settings.usage({ by, tenantId, transcripts: true })` to show a transcript
count per row, and pass `transcriptHref(filters)` to link each count and
outcome label to your own transcript page. `filters` holds `promptKey`
and `templateHash` (when the report is grouped by prompt or template),
`outcome`, `since` and `until`, which map onto `listAiTranscripts()`. The
panel never shows transcript text. When transcripts are off, the tab says
so in one line.

```svelte
<InferenceSettingsPanel
  {...data}
  appEditable={data.isPlatformAdmin}
  onSaveTranscripts={saveTranscripts}
  transcriptHref={(f) => `/admin/transcripts?${new URLSearchParams(f)}`}
/>
```

## Applying the bindings

Compose `createInferenceOverrideResolver({ db })` as the per-user
resolver's `fallback`, so stored user and tenant keys still win and the
chain validation of `@happyvertical/smrt-inference` stays outermost:

```ts
registerUserInferenceResolver(
  createUserInferenceResolver({ db, fallback: createInferenceOverrideResolver({ db }) }),
);
```

A bare `setInferenceResolver()` would drop that validation. For each call
the override resolver uses the stored row, or defers to config when nothing
is stored. Run `smrt db:migrate` to create `_smrt_inference_overrides`; the
runtime never creates the table. Fusions saved as app rows reach the
executor through the same resolver: an app row replaces a config or
`defineFusion()` fusion of the same name, and `listInferenceFusions()` marks
what each entry replaces (`shadows`) and why the executor would refuse it
(`issues`, seat prompt keys included). The whole picture (tiers, fallback,
fusions, modes, hosted inference, usage) is in
[Inference tiers, bindings and usage](./inference.md).
