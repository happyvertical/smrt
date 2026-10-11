<script lang="ts">
import { Badge, Disclosure } from '@happyvertical/smrt-ui';
import { Switch } from '@happyvertical/smrt-ui/forms';
import { type FeatureCard, optionList } from '../features/catalogue.ts';

interface Props {
  card: FeatureCard;
  on: boolean;
  /** Names of the recipes that keep this one on; non-empty locks the switch. */
  lockedBy: string[];
  /** Names of the recipes switching it on would also add. */
  alsoAdds: string[];
  onchange: (on: boolean) => void;
}

const { card, on, lockedBy, alsoAdds, onchange }: Props = $props();

const demo = $derived(card.demo);
const why = $derived(
  (demo?.reasons.length ?? 0) > 0 ||
    card.ownMode !== undefined ||
    card.packageNote !== undefined,
);
const secrets = $derived([
  ...new Set(card.providers.flatMap((p) => p.secrets)),
]);
const id = $derived(`feature-${card.id}`);
</script>

<li class="card" class:selected={on}>
  <div class="head">
    <h3>{card.label}</h3>
    {#if demo}
      <Badge variant={demo.variant} size="sm" title={demo.meaning}>{demo.label}</Badge>
    {/if}
  </div>
  <p class="summary" id={`${id}-summary`}>{card.summary}</p>
  <p class="meta">
    {#if demo}
      {demo.meaning}
    {:else}
      Demo status not reported for this feature.
    {/if}
  </p>

  <h4>You get</h4>
  <ul class="plain" aria-label={`${card.label}: what you get`}>
    {#each card.gets as item (`${item.kind}:${item.label}`)}
      <li>
        <span class="kind">{item.kindLabel}</span>
        {item.label}{#if item.where}<span class="meta where">({item.where})</span>{/if}
      </li>
    {/each}
  </ul>

  {#if card.providers.length}
    <h4>Needs</h4>
    <ul class="plain" aria-label={`${card.label}: providers`}>
      {#each card.providers as provider (provider.id)}
        <li>
          <span class="kind">{provider.kindLabel}</span>
          {provider.required ? 'Required' : 'Optional'}: {optionList(provider.options)}.
          {#if provider.browserOptions.length}
            <span class="meta">
              {optionList(provider.browserOptions, 'and')}
              {provider.browserOptions.length === 1 ? 'runs' : 'run'} in the
              browser with no key.
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if secrets.length}
      <p class="meta">
        Secrets (names only):
        {#each secrets as name, index (name)}<code>{name}</code>{index < secrets.length - 1 ? ', ' : ''}{/each}
      </p>
    {/if}
  {/if}

  {#if !on && alsoAdds.length}
    <p class="meta">Also adds {alsoAdds.join(', ')}.</p>
  {/if}

  {#if why}
    <Disclosure title={demo ? `Why ${demo.label}?` : 'Details'}>
      {#if demo?.reasons.length}
        <ul class="plain reasons" aria-label={`${card.label}: reasons`}>
          {#each demo.reasons as reason (reason)}<li>{reason}</li>{/each}
        </ul>
      {/if}
      {#if card.ownMode && demo}
        <p class="meta">On its own it would be {card.ownMode}; what it needs sets {demo.label}.</p>
      {/if}
      {#if card.packageNote}<p class="meta">{card.packageNote}</p>{/if}
    </Disclosure>
  {/if}

  <div class="foot">
    <Switch
      label={card.label}
      checked={on}
      disabled={lockedBy.length > 0}
      aria-describedby={`${id}-summary${lockedBy.length ? ` ${id}-locked` : ''}`}
      onchange={(event) => onchange(event.currentTarget.checked)}
    />
    {#if lockedBy.length}
      <p class="meta" id={`${id}-locked`}>Stays on while {lockedBy.join(', ')} needs it.</p>
    {/if}
  </div>
</li>

<style>
  h3,
  h4,
  p {
    margin: 0;
  }

  .card {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  .card.selected {
    border-color: var(--smrt-color-primary);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
  }

  h3 {
    font-size: var(--smrt-font-size-title-medium, 1rem);
  }

  h4 {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-font-size-label-medium, 0.75rem);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-font-size-body-small, 0.8125rem);
  }

  .plain {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--smrt-font-size-body-medium, 0.875rem);
  }

  .kind {
    margin-inline-end: var(--smrt-spacing-1);
    padding: 0 var(--smrt-spacing-2);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-font-size-label-small, 0.6875rem);
  }

  .reasons {
    margin-block-end: var(--smrt-spacing-2);
  }

  .foot {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin-top: var(--smrt-spacing-2);
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: 0.85em;
  }

  .where {
    margin-inline-start: 0.35em;
  }

  .summary {
    font-size: var(--smrt-font-size-body-medium, 0.875rem);
  }
</style>
