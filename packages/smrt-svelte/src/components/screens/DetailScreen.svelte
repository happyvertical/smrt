<script lang="ts">
/**
 * DetailScreen - a read-only record view for any model, derived from its
 * manifest definition and resolved field policy (#3718).
 *
 * Basic-tier fields show first, grouped by the policy/manifest `group`;
 * advanced-tier fields and the read-only created/updated timestamps sit
 * behind a "More details" disclosure. Hidden fields and fields outside the
 * policy never render, so a sensitive field the policy omits cannot leak
 * through this screen.
 *
 * Empty values (an empty JSON object or array included) show the "Not set"
 * placeholder; a JSON object shows as a compact key/value list. A reference
 * shows its target's label from `labels` (a link when `hrefFor` gives one);
 * without a label it falls back to a shortened id in `<code>`, the full id in
 * its tooltip.
 */
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Disclosure } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.screens.js';
import {
  deriveScreenFields,
  groupScreenFields,
  humanizeFieldName,
  screenSourceError,
  screenTitles,
} from './fields.js';
import type {
  DetailScreenProps,
  ScreenCollectionDefinition,
  ScreenField,
  ScreenPolicy,
  ScreenRecord,
} from './types.js';
import {
  formatScreenValue,
  jsonScreenEntries,
  shortScreenId,
} from './values.js';

let {
  definition,
  policy = null,
  record,
  title,
  fields: include,
  currency,
  locale,
  showHeader = true,
  backLabel,
  deleting = false,
  onback,
  onedit,
  ondelete,
  extraActions,
  children,
  relations = [],
  hrefFor,
  labels,
  exclude,
  hideEmpty = false,
  variant = 'plain',
}: DetailScreenProps = $props();

const { t } = useI18n();

const titles = $derived(screenTitles(definition));
const sourceError = $derived(screenSourceError(definition, policy));

const allFields = $derived(
  sourceError
    ? []
    : deriveScreenFields(definition, policy, { mode: 'view', include }),
);
const listed = $derived(
  exclude ? allFields.filter((f) => !exclude.includes(f.name)) : allFields,
);
const filled = $derived(
  hideEmpty ? listed.filter((f) => display(f) !== '') : listed,
);
const empty = $derived(
  hideEmpty ? listed.filter((f) => display(f) === '') : [],
);
const primary = $derived(filled.filter((f) => f.tier === 'basic'));
const secondary = $derived(filled.filter((f) => f.tier === 'advanced'));

const heading = $derived.by(() => {
  if (title) return title;
  const label = allFields.find((f) => f.kind === 'text' && f.tier === 'basic');
  const value = label ? record[label.name] : undefined;
  return typeof value === 'string' && value.trim() !== ''
    ? value
    : titles.singular;
});

const formatContext = $derived({
  currency,
  locale,
  yes: t(M['ui.screens.yes']),
  no: t(M['ui.screens.no']),
});

function display(field: ScreenField): string {
  return formatScreenValue(field, record[field.name], formatContext);
}

/** Only http(s) URLs become links; anything else renders as text. */
function safeHref(field: ScreenField, text: string): string | null {
  if (field.kind === 'email') return `mailto:${text}`;
  if (field.kind === 'url' && /^https?:\/\//i.test(text)) return text;
  return null;
}

/** A reference field's target model, from the `reference` relations. */
function targetModel(field: ScreenField): string | undefined {
  return relations.find((r) => r.kind === 'reference' && r.field === field.name)
    ?.model;
}

/** The referenced record's label, or `undefined` when nothing names it. */
function referenceLabel(field: ScreenField, id: string): string | undefined {
  const model = targetModel(field);
  const label = model ? labels?.[model]?.(id) : undefined;
  return label && label.trim() !== '' ? label : undefined;
}

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
</script>

{#snippet shortId(id: string)}<code title={id}>{shortScreenId(id)}</code>{/snippet}

{#snippet fieldList(list: ScreenField[])}
  {#each groupScreenFields(list) as [group, groupFields] (group ?? '')}
    <section class="smrt-detail-screen__group">
      {#if group}<h2 class="smrt-detail-screen__group-title">{group}</h2>{/if}
      <dl class="smrt-detail-screen__fields">
        {#each groupFields as field (field.name)}
          {@const text = display(field)}
          <div class="smrt-detail-screen__field">
            <dt>{field.label}</dt>
            <dd>
              {#if text === ''}
                <span class="smrt-detail-screen__empty">{t(M['ui.screens.not_set'])}</span>
              {:else if field.kind === 'json'}
                {@const entries = jsonScreenEntries(record[field.name])}
                {#if entries}
                  <dl class="smrt-detail-screen__pairs">
                    {#each entries as entry (entry.key)}
                      <div>
                        <dt>{humanizeFieldName(entry.key)}</dt>
                        <dd>{entry.value}</dd>
                      </div>
                    {/each}
                  </dl>
                {:else}
                  <pre class="smrt-detail-screen__block">{text}</pre>
                {/if}
              {:else if field.kind === 'textarea'}
                <pre class="smrt-detail-screen__block">{text}</pre>
              {:else if safeHref(field, text)}
                <a href={safeHref(field, text)}>{text}</a>
              {:else if field.kind === 'reference'}
                {@const href = hrefFor?.(field, text)}
                {@const label = referenceLabel(field, text)}
                {#if href}
                  <a href={href} class="smrt-detail-screen__reference">{#if label}{label}{:else}{@render shortId(text)}{/if}</a>
                {:else if label}
                  <span class="smrt-detail-screen__reference">{label}</span>
                {:else}
                  {@render shortId(text)}
                {/if}
              {:else}
                {text}
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
    </section>
  {/each}
{/snippet}

{#if showHeader}
  <PageHeader title={heading}>
    {#snippet actions()}
      {#if onback}
        <Button variant="ghost" onclick={onback}>
          {backLabel ?? t(M['ui.screens.back'], { name: titles.plural.toLowerCase() })}
        </Button>
      {/if}
      {#if extraActions}{@render extraActions()}{/if}
      {#if onedit}
        <Button variant="secondary" onclick={onedit}>{t(M['ui.screens.edit'])}</Button>
      {/if}
      {#if ondelete}
        <Button variant="danger" onclick={() => (confirmOpen = true)}>
          {t(M['ui.screens.delete'])}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>
{/if}

<article
  class="smrt-detail-screen"
  class:smrt-detail-screen--card={variant === 'card'}
  aria-label={variant === 'card' ? t(M['ui.screens.details']) : heading}
  data-smrt-component="DetailScreen"
>
  {#if sourceError}
    <Alert variant="error">{sourceError}</Alert>
  {:else}
    {#if deleteError}
      <Alert variant="error" dismissible ondismiss={() => (deleteError = false)}>
        {t(M['ui.screens.delete_failed'])}
      </Alert>
    {/if}
    {@render fieldList(primary)}
    {#if secondary.length > 0}
      <Disclosure title={t(M['ui.screens.more_details'])}>
        {@render fieldList(secondary)}
      </Disclosure>
    {/if}
    {#if empty.length > 0}
      <Disclosure title={t(M['ui.screens.show_empty'], { count: empty.length })}>
        {@render fieldList(empty)}
      </Disclosure>
    {/if}
    {@render children?.()}
  {/if}
</article>

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
  .smrt-detail-screen {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-detail-screen--card {
    padding: var(--smrt-spacing-md, 1rem);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-lg);
    background: var(--smrt-color-surface);
  }
  .smrt-detail-screen--card .smrt-detail-screen__fields {
    grid-template-columns: repeat(auto-fill, minmax(max(14rem, 40%), 1fr));
  }
  .smrt-detail-screen__group-title {
    margin: 0 0 var(--smrt-spacing-sm, 0.5rem);
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-detail-screen__fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
    margin: 0;
  }
  .smrt-detail-screen__field dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-detail-screen__field dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .smrt-detail-screen__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-detail-screen__pairs {
    display: grid;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin: 0;
  }
  .smrt-detail-screen__pairs div {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-detail-screen__pairs dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-detail-screen__pairs dd {
    margin: 0;
  }
  .smrt-detail-screen__block {
    margin: 0;
    white-space: pre-wrap;
    font-family: inherit;
  }
}
</style>
