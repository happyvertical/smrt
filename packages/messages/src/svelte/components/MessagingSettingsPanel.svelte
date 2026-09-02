<script lang="ts">
import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { PersonaMessageRoute } from '../../models/PersonaMessageRoute.js';
import type { MessagingProviderDefinition } from '../../providers.js';
import type {
  MessagingAccountInput,
  MessagingAccountView,
  MessagingEndpointInput,
  MessagingEndpointView,
  PersonaMessageRouteInput,
} from '../../services/MessagingSettingsService.js';
import { M } from '../i18n.messages.js';
import { coerceMessagingProviderValues } from '../messaging-settings.js';

const { t } = useI18n();

type PublicProvider = Omit<MessagingProviderDefinition, 'createSender'>;

export interface Props {
  /** Persona ID to configure messaging settings for. */
  personaId: string;
  /** Current user's profile, attached to destinations created by this panel. */
  profileId?: string;
  /** Available messaging providers to choose from. */
  providers: PublicProvider[];
  /** Configured messaging accounts to display and manage. */
  accounts: MessagingAccountView[];
  /** Configured message endpoints for sending. */
  endpoints: MessagingEndpointView[];
  /** Configured routing rules mapping message types to endpoints. */
  routes: PersonaMessageRoute[];
  /** Called when user saves account settings. */
  onSaveAccount?: (input: MessagingAccountInput) => Promise<void>;
  /** Called when user saves endpoint settings. */
  onSaveEndpoint?: (input: MessagingEndpointInput) => Promise<void>;
  /** Called when user saves message route settings. */
  onSaveRoute?: (input: PersonaMessageRouteInput) => Promise<void>;
  /** Disables editing when true; view-only mode. */
  readonly?: boolean;
}

let {
  personaId,
  profileId,
  providers,
  accounts,
  endpoints,
  routes,
  onSaveAccount,
  onSaveEndpoint,
  onSaveRoute,
  readonly = false,
}: Props = $props();

let openForm = $state<'account' | 'endpoint' | 'route' | null>(null);
let saving = $state(false);
let error = $state('');

let accountId = $state<string | undefined>();
let accountName = $state('');
let accountProviderId = $state('');
let accountConfiguration = $state<Record<string, string>>({});
let accountCredentials = $state<Record<string, string>>({});
let accountActive = $state(true);

let endpointId = $state<string | undefined>();
let endpointLabel = $state('');
let endpointProviderId = $state('');
let endpointAddress = $state<Record<string, string>>({});
let endpointActive = $state(true);
let endpointProfileId = $state<string | null>(null);

let routeId = $state<string | undefined>();
let routeAccountId = $state('');
let routeEndpointId = $state('');
let routePurpose = $state('default');
let routePriority = $state(0);
let routeEnabled = $state(true);

const activeAccountProvider = $derived(
  providers.find((provider) => provider.id === accountProviderId),
);
const activeEndpointProvider = $derived(
  providers.find((provider) => provider.id === endpointProviderId),
);

function setValue(target: Record<string, string>, id: string, event: Event) {
  target[id] = (event.currentTarget as HTMLInputElement).value;
}

function selectAccountProvider(event: Event) {
  accountProviderId = (event.currentTarget as HTMLSelectElement).value;
  accountConfiguration = {};
  accountCredentials = {};
  accountActive = true;
}

function selectEndpointProvider(event: Event) {
  endpointProviderId = (event.currentTarget as HTMLSelectElement).value;
  endpointAddress = {};
}

function reset() {
  openForm = null;
  error = '';
  accountId = undefined;
  accountName = '';
  accountProviderId = '';
  accountConfiguration = {};
  accountCredentials = {};
  accountActive = true;
  endpointId = undefined;
  endpointLabel = '';
  endpointProviderId = '';
  endpointAddress = {};
  endpointActive = true;
  endpointProfileId = profileId ?? null;
  routeId = undefined;
  routeAccountId = '';
  routeEndpointId = '';
  routePurpose = 'default';
  routePriority = 0;
  routeEnabled = true;
}

function editAccount(account: MessagingAccountView) {
  reset();
  accountId = account.id;
  accountName = account.name;
  accountProviderId = account.providerId;
  accountConfiguration = Object.fromEntries(
    Object.entries(account.configuration).map(([key, value]) => [
      key,
      String(value ?? ''),
    ]),
  );
  accountActive = account.active;
  openForm = 'account';
}

function replaceEndpoint(endpoint: MessagingEndpointView) {
  reset();
  endpointId = endpoint.id;
  endpointLabel = endpoint.label;
  endpointProviderId =
    providers.find((provider) => provider.channel === endpoint.channel)?.id ??
    '';
  endpointActive = endpoint.active;
  endpointProfileId = endpoint.profileId;
  openForm = 'endpoint';
}

function editRoute(route: PersonaMessageRoute) {
  reset();
  routeId = route.id ?? undefined;
  routeAccountId = route.accountId;
  routeEndpointId = route.endpointId;
  routePurpose = route.purpose;
  routePriority = route.priority;
  routeEnabled = route.enabled;
  openForm = 'route';
}

async function saveAccount() {
  if (!onSaveAccount || !activeAccountProvider) return;
  saving = true;
  error = '';
  try {
    const credentials = coerceMessagingProviderValues(
      accountCredentials,
      activeAccountProvider.credentialFields,
    );
    await onSaveAccount({
      id: accountId,
      name: accountName,
      providerId: activeAccountProvider.id,
      configuration: coerceMessagingProviderValues(
        accountConfiguration,
        activeAccountProvider.configurationFields,
      ),
      credentials:
        Object.keys(credentials).length > 0 ? credentials : undefined,
      active: accountActive,
    });
    reset();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving = false;
  }
}

async function saveEndpoint() {
  if (!onSaveEndpoint || !activeEndpointProvider) return;
  saving = true;
  error = '';
  try {
    await onSaveEndpoint({
      id: endpointId,
      label: endpointLabel,
      providerId: activeEndpointProvider.id,
      profileId: endpointProfileId,
      address: coerceMessagingProviderValues(
        endpointAddress,
        activeEndpointProvider.endpointFields,
      ),
      active: endpointActive,
    });
    reset();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving = false;
  }
}

async function saveRoute() {
  if (!onSaveRoute) return;
  saving = true;
  error = '';
  try {
    await onSaveRoute({
      id: routeId,
      personaId,
      accountId: routeAccountId,
      endpointId: routeEndpointId,
      purpose: routePurpose,
      priority: routePriority,
      enabled: routeEnabled,
    });
    reset();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving = false;
  }
}
</script>

<div class="messaging-settings">
  <section>
    <header>
      <div><h3>{t(M['messages.messaging_settings.accounts_title'])}</h3><p>{t(M['messages.messaging_settings.accounts_description'])}</p></div>
      {#if !readonly && onSaveAccount}<Button size="sm" onclick={() => { reset(); openForm = 'account'; }}>{t(M['messages.messaging_settings.add_account'])}</Button>{/if}
    </header>
    <div class="items">
      {#each accounts as account (account.id)}
        <Button class="item" type="button" onclick={() => editAccount(account)} disabled={readonly}>
          <span><strong>{account.name}</strong><small>{account.providerId} · {account.channel}</small></span>
          <span class:ok={account.hasCredentials}>{account.hasCredentials ? t(M['messages.messaging_settings.credentials_stored']) : t(M['messages.messaging_settings.credentials_missing'])}</span>
        </Button>
      {:else}<p class="empty">{t(M['messages.messaging_settings.no_accounts'])}</p>{/each}
    </div>
  </section>

  <section>
    <header>
      <div><h3>{t(M['messages.messaging_settings.destinations_title'])}</h3><p>{t(M['messages.messaging_settings.destinations_description'])}</p></div>
      {#if !readonly && onSaveEndpoint}<Button size="sm" onclick={() => { reset(); openForm = 'endpoint'; }}>{t(M['messages.messaging_settings.add_destination'])}</Button>{/if}
    </header>
    <div class="items">
      {#each endpoints as endpoint (endpoint.id)}
        <Button class="item" type="button" onclick={() => replaceEndpoint(endpoint)} disabled={readonly}>
          <span><strong>{endpoint.label}</strong><small>{endpoint.channel}</small></span>
          <span>{endpoint.maskedAddress}</span>
        </Button>
      {:else}<p class="empty">{t(M['messages.messaging_settings.no_destinations'])}</p>{/each}
    </div>
  </section>

  <section>
    <header>
      <div><h3>{t(M['messages.messaging_settings.routes_title'])}</h3><p>{t(M['messages.messaging_settings.routes_description'])}</p></div>
      {#if !readonly && onSaveRoute}<Button size="sm" onclick={() => { reset(); openForm = 'route'; }}>{t(M['messages.messaging_settings.add_route'])}</Button>{/if}
    </header>
    <div class="items">
      {#each routes as route (route.id)}
        <Button class="item" type="button" onclick={() => editRoute(route)} disabled={readonly}>
          <span><strong>{route.purpose}</strong><small>{t(M['messages.messaging_settings.priority_value'], { priority: route.priority })}</small></span>
          <span>{accounts.find((account) => account.id === route.accountId)?.name ?? t(M['messages.messaging_settings.missing_account'])} → {endpoints.find((endpoint) => endpoint.id === route.endpointId)?.label ?? t(M['messages.messaging_settings.missing_destination'])}</span>
        </Button>
      {:else}<p class="empty">{t(M['messages.messaging_settings.no_routes'])}</p>{/each}
    </div>
  </section>

  {#if openForm === 'account'}
    <Form class="editor" onsubmit={saveAccount}>
      <h3>{t(M[accountId ? 'messages.messaging_settings.edit_account_title' : 'messages.messaging_settings.add_account_title'])}</h3>
      <label for="messaging-account-name">{t(M['messages.messaging_settings.name'])}</label>
      <Input id="messaging-account-name" bind:value={accountName} required disabled={saving} />
      <label for="messaging-account-provider">{t(M['messages.messaging_settings.provider'])}</label>
      <Select id="messaging-account-provider" value={accountProviderId} onchange={selectAccountProvider} required disabled={saving || Boolean(accountId)}>
        <option value="">{t(M['messages.messaging_settings.select'])}</option>
        {#each providers.filter((provider) => provider.available) as provider}<option value={provider.id}>{provider.label}</option>{/each}
      </Select>
      {#if activeAccountProvider}
        {#each activeAccountProvider.configurationFields as field (field.id)}
          <label for={`account-config-${field.id}`}>{field.label}</label>
          {#if field.type === 'select'}
            <Select id={`account-config-${field.id}`} value={accountConfiguration[field.id] ?? ''} onchange={(event) => setValue(accountConfiguration, field.id, event)} required={field.required} disabled={saving}>
              <option value="">{t(M['messages.messaging_settings.select'])}</option>
              {#each field.options ?? [] as option}<option value={option.value}>{option.label}</option>{/each}
            </Select>
          {:else}
            <Input id={`account-config-${field.id}`} type={field.type === 'string' ? 'text' : field.type} value={accountConfiguration[field.id] ?? ''} oninput={(event) => setValue(accountConfiguration, field.id, event)} required={field.required} disabled={saving} />
          {/if}
        {/each}
        <h4>{t(M['messages.messaging_settings.credentials'])}</h4>
        {#if accountId}<p class="secret-note">{t(M['messages.messaging_settings.credentials_note'])}</p>{/if}
        {#each activeAccountProvider.credentialFields as field (field.id)}
          <label for={`account-secret-${field.id}`}>{field.label}</label>
          {#if field.type === 'select'}
            <Select id={`account-secret-${field.id}`} value={accountCredentials[field.id] ?? ''} onchange={(event) => setValue(accountCredentials, field.id, event)} required={field.required && !accountId} disabled={saving}>
              <option value="">{t(M['messages.messaging_settings.select'])}</option>
              {#each field.options ?? [] as option}<option value={option.value}>{option.label}</option>{/each}
            </Select>
          {:else}
            <Input id={`account-secret-${field.id}`} type={field.type === 'password' ? 'password' : field.type === 'string' ? 'text' : field.type} value={accountCredentials[field.id] ?? ''} oninput={(event) => setValue(accountCredentials, field.id, event)} required={field.required && !accountId} disabled={saving} autocomplete="new-password" />
          {/if}
        {/each}
      {/if}
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox preserves checkbox semantics without requiring a Provider -->
        <input type="checkbox" bind:checked={accountActive} disabled={saving} />
        {t(M['messages.messaging_settings.account_active'])}
      </label>
      <div class="actions"><Button variant="secondary" onclick={reset} disabled={saving}>{t(M['messages.messaging_settings.cancel'])}</Button><Button type="submit" disabled={saving || !activeAccountProvider}>{t(M['messages.messaging_settings.save_account'])}</Button></div>
    </Form>
  {:else if openForm === 'endpoint'}
    <Form class="editor" onsubmit={saveEndpoint}>
      <h3>{t(M[endpointId ? 'messages.messaging_settings.replace_destination_title' : 'messages.messaging_settings.add_destination_title'])}</h3>
      {#if endpointId}<p class="secret-note">{t(M['messages.messaging_settings.destination_note'])}</p>{/if}
      <label for="messaging-endpoint-label">{t(M['messages.messaging_settings.label'])}</label>
      <Input id="messaging-endpoint-label" bind:value={endpointLabel} required disabled={saving} />
      <label for="messaging-endpoint-provider">{t(M['messages.messaging_settings.provider'])}</label>
      <Select id="messaging-endpoint-provider" value={endpointProviderId} onchange={selectEndpointProvider} required disabled={saving || Boolean(endpointId)}>
        <option value="">{t(M['messages.messaging_settings.select'])}</option>
        {#each providers.filter((provider) => provider.available) as provider}<option value={provider.id}>{provider.label}</option>{/each}
      </Select>
      {#if activeEndpointProvider}
        {#each activeEndpointProvider.endpointFields as field (field.id)}
          <label for={`endpoint-${field.id}`}>{field.label}</label>
          {#if field.type === 'select'}
            <Select id={`endpoint-${field.id}`} value={endpointAddress[field.id] ?? ''} onchange={(event) => setValue(endpointAddress, field.id, event)} required={field.required} disabled={saving}>
              <option value="">{t(M['messages.messaging_settings.select'])}</option>
              {#each field.options ?? [] as option}<option value={option.value}>{option.label}</option>{/each}
            </Select>
          {:else}
            <Input id={`endpoint-${field.id}`} type={field.type === 'string' ? 'text' : field.type} value={endpointAddress[field.id] ?? ''} oninput={(event) => setValue(endpointAddress, field.id, event)} required={field.required} disabled={saving} />
          {/if}
        {/each}
      {/if}
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox preserves checkbox semantics without requiring a Provider -->
        <input type="checkbox" bind:checked={endpointActive} disabled={saving} />
        {t(M['messages.messaging_settings.destination_active'])}
      </label>
      <div class="actions"><Button variant="secondary" onclick={reset} disabled={saving}>{t(M['messages.messaging_settings.cancel'])}</Button><Button type="submit" disabled={saving || !activeEndpointProvider}>{t(M['messages.messaging_settings.save_destination'])}</Button></div>
    </Form>
  {:else if openForm === 'route'}
    <Form class="editor" onsubmit={saveRoute}>
      <h3>{t(M[routeId ? 'messages.messaging_settings.edit_route_title' : 'messages.messaging_settings.add_route_title'])}</h3>
      <label for="messaging-route-account">{t(M['messages.messaging_settings.sending_account'])}</label>
      <Select id="messaging-route-account" bind:value={routeAccountId} required disabled={saving}>
        <option value="">{t(M['messages.messaging_settings.select'])}</option>
        {#each accounts.filter((account) => account.active) as account}<option value={account.id}>{account.name} ({account.channel})</option>{/each}
      </Select>
      <label for="messaging-route-endpoint">{t(M['messages.messaging_settings.destination'])}</label>
      <Select id="messaging-route-endpoint" bind:value={routeEndpointId} required disabled={saving}>
        <option value="">{t(M['messages.messaging_settings.select'])}</option>
        {#each endpoints.filter((endpoint) => endpoint.active && (!routeAccountId || endpoint.channel === accounts.find((account) => account.id === routeAccountId)?.channel)) as endpoint}<option value={endpoint.id}>{endpoint.label} ({endpoint.channel})</option>{/each}
      </Select>
      <label for="messaging-route-purpose">{t(M['messages.messaging_settings.purpose'])}</label>
      <Input id="messaging-route-purpose" bind:value={routePurpose} required disabled={saving} />
      <label for="messaging-route-priority">{t(M['messages.messaging_settings.priority'])}</label>
      <Input id="messaging-route-priority" type="number" bind:value={routePriority} disabled={saving} />
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox preserves checkbox semantics without requiring a Provider -->
        <input type="checkbox" bind:checked={routeEnabled} disabled={saving} />
        {t(M['messages.messaging_settings.route_enabled'])}
      </label>
      <div class="actions"><Button variant="secondary" onclick={reset} disabled={saving}>{t(M['messages.messaging_settings.cancel'])}</Button><Button type="submit" disabled={saving}>{t(M['messages.messaging_settings.save_route'])}</Button></div>
    </Form>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .messaging-settings { display: grid; gap: 1.5rem; }
  section { display: grid; gap: 0.75rem; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
  h3, h4, p { margin: 0; }
  header p, small, .secret-note, .empty { color: var(--smrt-color-on-surface-variant, #64748b); }
  .items { display: grid; gap: 0.5rem; }
  :global(.item) { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.875rem; text-align: left; background: var(--smrt-color-surface, #fff); color: inherit; border: 1px solid var(--smrt-color-outline-variant, #e2e8f0); border-radius: 0.5rem; }
  :global(.item:not(:disabled)) { cursor: pointer; }
  :global(.item span:first-child) { display: grid; gap: 0.2rem; }
  .ok { color: var(--smrt-color-success, #15803d); }
  :global(.editor) { display: grid; gap: 0.65rem; padding: 1rem; border: 1px solid var(--smrt-color-outline-variant, #e2e8f0); border-radius: 0.5rem; background: var(--smrt-color-surface-container-low, #f8fafc); }
  label { font-weight: var(--smrt-typography-weight-semibold, 600); }
  .checkbox { display: flex; align-items: center; gap: 0.5rem; }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }
  .error { color: var(--smrt-color-error, #b91c1c); }
</style>
