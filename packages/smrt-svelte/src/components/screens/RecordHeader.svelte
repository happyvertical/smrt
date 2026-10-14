<script lang="ts">
/**
 * RecordHeader (internal to `RecordScreen`, #3718 record page): a small
 * back link above the title, the heading (a document leads with its
 * identifier, "Order GRA-3159"), the monospace identifier, the status badge
 * (toned by value, neutral when unmapped) and the key facts (party link,
 * date, total money, contact). Actions: Edit is the one primary button; an
 * overflow menu holds the host's `extraActions` and Delete, which asks for
 * confirmation. The model is `deriveRecordHeader`.
 */
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Button, Popover } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.screens.js';
import type { RecordStatusTone } from '../overview/widgets/data.js';
import { statusLabel, statusTone } from '../overview/widgets/record-table.js';
import { screenTitles } from './fields.js';
import type { RecordFact, RecordHeaderModel } from './record-header.js';
import type { ScreenRelation } from './relations.js';
import type {
  ScreenCollectionDefinition,
  ScreenField,
  ScreenRecord,
} from './types.js';
import { formatScreenValue, shortScreenId } from './values.js';

interface Props {
  definition: ScreenCollectionDefinition;
  model: RecordHeaderModel;
  record: ScreenRecord;
  relations?: readonly ScreenRelation[];
  hrefFor?: (field: ScreenField, id: string) => string | undefined;
  labels?: Readonly<Record<string, (id: string) => string | undefined>>;
  currency?: string;
  locale?: string;
  backLabel?: string;
  deleting?: boolean;
  statusTones?: Readonly<Record<string, RecordStatusTone>>;
  onback?: () => void;
  onedit?: () => void;
  ondelete?: () => void | Promise<void>;
  extraActions?: Snippet;
}

let {
  definition,
  model,
  record,
  relations = [],
  hrefFor,
  labels,
  currency,
  locale,
  backLabel,
  deleting = false,
  statusTones,
  onback,
  onedit,
  ondelete,
  extraActions,
}: Props = $props();

const { t } = useI18n();
const titles = $derived(screenTitles(definition));
const hasMenu = $derived(Boolean(extraActions || ondelete));

let menuOpen = $state(false);
let confirmOpen = $state(false);
let deleteError = $state(false);

async function confirmDelete(): Promise<void> {
  deleteError = false;
  try {
    await ondelete?.();
    confirmOpen = false;
  } catch {
    deleteError = true;
    confirmOpen = false;
  }
}

function referenceLabel(field: ScreenField, id: string): string | undefined {
  const target = relations.find(
    (r) => r.kind === 'reference' && r.field === field.name,
  )?.model;
  const label = target ? labels?.[target]?.(id) : undefined;
  return label && label.trim() !== '' ? label : undefined;
}

function factText(fact: RecordFact): string {
  const value = record[fact.field.name];
  if (fact.kind === 'date') {
    return formatScreenValue(
      { kind: 'datetime', definition: { format: 'date' } },
      value,
      { locale },
    );
  }
  return formatScreenValue(fact.field, value, { currency, locale });
}

function contactHref(fact: RecordFact, text: string): string | undefined {
  if (fact.field.kind === 'email') return `mailto:${text}`;
  if (fact.field.kind === 'tel') return `tel:${text.replace(/[^\d+]/g, '')}`;
  return undefined;
}
</script>

<header class="smrt-record-header" data-smrt-component="RecordHeader">
  {#if onback}
    <Button variant="ghost" size="sm" onclick={onback}>
      {backLabel ?? t(M['ui.screens.back'], { name: titles.plural.toLowerCase() })}
    </Button>
  {/if}
  <div class="smrt-record-header__row">
    <div class="smrt-record-header__identity">
      <h1 class="smrt-record-header__title">
        {#if model.headingIdentifier && model.identifier}
          {model.heading.slice(0, model.heading.length - model.identifier.value.length)}<code
            class="smrt-record-header__id">{model.identifier.value}</code
          >
        {:else}
          {model.heading}
        {/if}
      </h1>
      {#if model.identifier && !model.headingIdentifier}
        <code class="smrt-record-header__id smrt-record-header__id--chip" title={model.identifier.field.label}
          >{model.identifier.value}</code
        >
      {/if}
      {#if model.status}
        <Badge variant={statusTone(model.status.value, statusTones)}>
          <span class="smrt-record-header__sr">{model.status.field.label}: </span>{statusLabel(model.status.value)}
        </Badge>
      {/if}
    </div>
    <div class="smrt-record-header__actions">
      {#if onedit}
        <Button variant="primary" onclick={onedit}>{t(M['ui.screens.edit'])}</Button>
      {/if}
      {#if hasMenu}
        <Popover
          label={t(M['ui.screens.more_actions'])}
          triggerLabel={t(M['ui.screens.more_actions'])}
          variant="icon"
          placement="bottom-end"
          bind:open={menuOpen}
        >
          {#snippet trigger()}<span aria-hidden="true">⋯</span>{/snippet}
          <div class="smrt-record-header__menu">
            {#if extraActions}{@render extraActions()}{/if}
            {#if ondelete}
              <Button
                variant="danger"
                onclick={() => {
                  menuOpen = false;
                  confirmOpen = true;
                }}
              >
                {t(M['ui.screens.delete'])}
              </Button>
            {/if}
          </div>
        </Popover>
      {/if}
    </div>
  </div>
  {#if model.facts.length > 0}
    <dl class="smrt-record-header__facts">
      {#each model.facts as fact (fact.field.name)}
        {@const text = factText(fact)}
        <div class="smrt-record-header__fact">
          <dt>{fact.field.label}</dt>
          <dd>
            {#if fact.kind === 'party'}
              {@const href = hrefFor?.(fact.field, text)}
              {@const label = referenceLabel(fact.field, text)}
              {#if href}
                <a {href}>{#if label}{label}{:else}<code title={text}>{shortScreenId(text)}</code>{/if}</a>
              {:else if label}
                {label}
              {:else}
                <code title={text}>{shortScreenId(text)}</code>
              {/if}
            {:else if fact.kind === 'contact' && contactHref(fact, text)}
              <a href={contactHref(fact, text)}>{text}</a>
            {:else}
              {text}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
  {/if}
  {#if deleteError}
    <Alert variant="error" dismissible ondismiss={() => (deleteError = false)}>
      {t(M['ui.screens.delete_failed'])}
    </Alert>
  {/if}
</header>

{#if ondelete}
  <ConfirmDialog
    open={confirmOpen}
    title={t(M['ui.screens.delete_title'], { name: titles.singular.toLowerCase() })}
    message={t(M['ui.screens.delete_message'])}
    confirmLabel={t(M['ui.screens.delete'])}
    cancelLabel={t(M['ui.screens.cancel'])}
    destructive
    loading={deleting}
    onconfirm={confirmDelete}
    oncancel={() => (confirmOpen = false)}
  />
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-record-header { display: grid; gap: var(--smrt-spacing-2); justify-items: start; }
  .smrt-record-header__row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); inline-size: 100%; }
  .smrt-record-header__identity { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-2) var(--smrt-spacing-3); min-inline-size: 0; }
  .smrt-record-header__title { margin: 0; font-size: var(--smrt-typography-headline-small-size, 1.5rem); font-weight: var(--smrt-typography-weight-semibold); overflow-wrap: anywhere; }
  .smrt-record-header__id { font-family: var(--smrt-font-family-mono); }
  .smrt-record-header__id--chip { padding: 0 var(--smrt-spacing-2); border-radius: var(--smrt-radius-sm); background: var(--smrt-color-surface-container); color: var(--smrt-color-on-surface-variant); }
  .smrt-record-header__actions { display: flex; align-items: center; gap: var(--smrt-spacing-2); }
  .smrt-record-header__menu { display: grid; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-2); min-inline-size: 10rem; }
  .smrt-record-header__facts { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2) var(--smrt-spacing-6); margin: 0; }
  .smrt-record-header__fact { display: grid; gap: 0; }
  .smrt-record-header__fact dt { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size, 0.75rem); }
  .smrt-record-header__fact dd { margin: 0; font-variant-numeric: tabular-nums; }
  .smrt-record-header__sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 47.99rem) {
    .smrt-record-header__actions { inline-size: 100%; }
    .smrt-record-header__actions > :global(:first-child) { flex: 1; }
  }
}
</style>
