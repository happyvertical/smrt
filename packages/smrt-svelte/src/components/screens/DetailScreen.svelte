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
 */
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Disclosure } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.screens.js';
import {
  deriveScreenFields,
  groupScreenFields,
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
import { formatScreenValue } from './values.js';

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
}: DetailScreenProps = $props();

const { t } = useI18n();

const titles = $derived(screenTitles(definition));
const sourceError = $derived(screenSourceError(definition, policy));

const allFields = $derived(
  sourceError
    ? []
    : deriveScreenFields(definition, policy, { mode: 'view', include }),
);
const primary = $derived(allFields.filter((f) => f.tier === 'basic'));
const secondary = $derived(allFields.filter((f) => f.tier === 'advanced'));

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
              {:else if field.kind === 'json' || field.kind === 'textarea'}
                <pre class="smrt-detail-screen__block">{text}</pre>
              {:else if safeHref(field, text)}
                <a href={safeHref(field, text)}>{text}</a>
              {:else if field.kind === 'reference'}
                <code>{text}</code>
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

<article class="smrt-detail-screen" aria-label={heading}>
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
  .smrt-detail-screen {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
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
    color: var(--smrt-color-on-surface-variant, #5f6368);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-detail-screen__field dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .smrt-detail-screen__empty {
    color: var(--smrt-color-on-surface-variant, #5f6368);
  }
  .smrt-detail-screen__block {
    margin: 0;
    white-space: pre-wrap;
    font-family: inherit;
  }
</style>
