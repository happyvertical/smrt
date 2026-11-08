# Inference settings

`@happyvertical/smrt-inference` ships an inference settings screen (#4754):
`InferenceSettingsPanel` on `./svelte` for the browser, and
`InferenceSettingsService` on `./server` for the load functions and actions
behind it. The panel is presentational; your host decides who may see and
change what.

## Where each setting lives

| Setting | Store | Written by |
| --- | --- | --- |
| API keys | smrt-secrets (`SecretService`) | the host's `onSaveKey` action, using `bindInferenceKey()` |
| Mode, provider, base URL, model, default tier (per user, tenant default) | smrt-preferences kind `inference` | `createInferencePreferences(store).write()` |
| Tier bindings, `auto`'s default tier, aliases, fusions (app and tenant) | `_smrt_inference_overrides` | `InferenceSettingsService` set methods (authorizer-gated) |

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
    const form = await request.formData();
    const choices = (await createInferencePreferences(locals.preferenceStore).read()).choices;
    const record = bindInferenceKey({
      provider: String(form.get('provider')),
      key: String(form.get('key')),
      baseUrl: choices.baseUrl,
    });
    await locals.secrets.store(`inference.key.${record.provider}`, JSON.stringify(record));
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

## Applying the bindings

Register `createInferenceOverrideResolver({ db })` with core's
`setInferenceResolver()`. For each call it uses the stored binding, or
defers to its `base` resolver or to config when nothing is stored. Run
`smrt db:migrate` to create `_smrt_inference_overrides`; the runtime never
creates the table.
