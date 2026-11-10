<script lang="ts">
import { onDestroy } from 'svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { highlightCss } from '../theme/css-highlight.ts';
import {
  approveCustomCss,
  containCustomCss,
  customCssApproved,
  customCssDisabled,
  shellScopeOf,
} from '../theme/custom-css.svelte.ts';

interface Props {
  backHref?: string;
}
let { backHref = '#/configure/' }: Props = $props();
const css = $derived(cookbookStore.theme?.customCss ?? '');
let draftCss = $state('');
let editing = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;
const tokens = $derived(highlightCss(draftCss));
// CSS that arrived with a cookbook waits for the visitor's approval.
const pending = $derived(Boolean(css) && !editing && !customCssApproved(css));
let highlight = $state<HTMLElement | null>(null);
let editor = $state<HTMLTextAreaElement | null>(null);

$effect(() => {
  const stored = css;
  if (!editing || stored === draftCss) {
    draftCss = stored;
    editing = false;
  }
});

// Keep the current keystrokes on screen while the host confirms the cookbook.
$effect(() => {
  if (typeof document === 'undefined' || !editing || !draftCss) return;
  if (customCssDisabled(location.search)) return;
  const scope = shellScopeOf(editor);
  if (!scope) return;
  const contained = containCustomCss(draftCss, scope);
  if (!contained) return;
  const style = document.createElement('style');
  style.dataset.smrtPlannerDraft = '';
  style.textContent = contained;
  document.head.append(style);
  return () => style.remove();
});

function syncScroll() {
  if (highlight && editor) {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }
}

function setCss(value: string) {
  cookbookStore.setTheme({
    ...cookbookStore.theme,
    customCss: value || undefined,
  });
}

function editCss(value: string) {
  // What the visitor types here is theirs to apply.
  approveCustomCss(value);
  draftCss = value;
  editing = true;
  clearTimeout(timer);
  timer = setTimeout(() => setCss(draftCss), 400);
}

onDestroy(() => {
  clearTimeout(timer);
  if (editing) setCss(draftCss);
});
</script>

<section class="smrt-advanced-styles__root" aria-labelledby="advanced-styles-title" data-smrt-component="AdvancedStyles">
  <a class="smrt-advanced-styles__back" href={backHref} data-sveltekit-reload={backHref.startsWith('/') ? true : undefined} data-smrt-part="nav">← Back to Theme</a>
  <div class="smrt-advanced-styles__heading" data-smrt-part="heading">
    <div>
      <h1 id="advanced-styles-title">Advanced Styles</h1>
      <p>Make this app your own with CSS. Changes appear as you type and are saved with your cookbook.</p>
    </div>
    <span class="smrt-advanced-styles__live" data-smrt-part="status"><span aria-hidden="true"></span>Live preview</span>
  </div>
  {#if pending}
    <div class="smrt-advanced-styles__pending" data-smrt-part="notice" role="status">
      <p>This cookbook brings its own CSS. It is not applied until you review and approve it.</p>
      <button type="button" onclick={() => approveCustomCss(css)}>Apply these styles</button>
    </div>
  {/if}
  <label for="advanced-css">Custom CSS</label>
  <div class="smrt-advanced-styles__editor" data-smrt-part="main">
    <pre bind:this={highlight} aria-hidden="true"><code>{#each tokens as token}<span data-smrt-part="token" class:smrt-advanced-styles__comment={token.kind === 'comment'} class:smrt-advanced-styles__selector={token.kind === 'selector'} class:smrt-advanced-styles__property={token.kind === 'property'} class:smrt-advanced-styles__value={token.kind === 'value'} class:smrt-advanced-styles__punctuation={token.kind === 'punctuation'}>{token.text}</span>{/each}</code></pre>
    <textarea id="advanced-css" bind:this={editor} value={draftCss} oninput={(event) => editCss(event.currentTarget.value)}
      onscroll={syncScroll} spellcheck="false" maxlength="65536" wrap="off"
      placeholder="/* Add your app styles here */" aria-describedby="advanced-css-help"></textarea>
  </div>
  <p id="advanced-css-help" class="smrt-advanced-styles__help" data-smrt-part="hint">Ask your agent to write styles here, or start with a selector like <code>.smrt-admin-shell</code>. Clearing the editor removes your custom styles. Styles apply only inside the app shell and cannot load files from other sites; add <code>?styles=off</code> to the address to turn them off.</p>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-advanced-styles__root {
    display: grid;
    gap: 1rem;
    max-inline-size: 72rem;
  }
  .smrt-advanced-styles__pending {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-3);
  }
  .smrt-advanced-styles__pending p {
    margin: 0;
  }
  .smrt-advanced-styles__heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
  }
  h1, p {
    margin: 0;
  }
  .smrt-advanced-styles__heading p {
    margin-top: .35rem;
  }
  .smrt-advanced-styles__live {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    flex: none;
    padding: .4rem .65rem;
  }
  .smrt-advanced-styles__live span {
    inline-size: .5rem;
    block-size: .5rem;
  }
  .smrt-advanced-styles__editor {
    position: relative;
    min-block-size: 24rem;
    overflow: hidden;
  }
  pre, textarea {
    box-sizing: border-box;
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    margin: 0;
    padding: 1rem;
    overflow: auto;
    white-space: pre;
  }
  pre {
    pointer-events: none;
  }
  textarea {
    z-index: 1;
    resize: none;
  }
  @media (max-width: 42rem) {
    .smrt-advanced-styles__heading {
      display: grid;
    }
    .smrt-advanced-styles__live {
      justify-self: start;
    }
  }
}

@layer smrt.theme {
  .smrt-advanced-styles__pending {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
  }
  .smrt-advanced-styles__back {
    color: var(--smrt-color-primary);
    font-weight: 700;
    text-decoration: none;
  }
  .smrt-advanced-styles__back:hover {
    text-decoration: underline;
  }
  h1 {
    font: var(--smrt-typography-headline-large-font);
    letter-spacing: var(--smrt-typography-headline-large-tracking);
  }
  .smrt-advanced-styles__heading p, .smrt-advanced-styles__help {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-advanced-styles__live {
    border-radius: 2rem;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font-size: .8rem;
    font-weight: 700;
  }
  .smrt-advanced-styles__live span {
    border-radius: 50%;
    background: var(--smrt-color-primary);
  }
  label {
    font-weight: 700;
  }
  .smrt-advanced-styles__editor {
    border: var(--smrt-control-border);
    border-radius: var(--smrt-radius-large, .75rem);
    background: var(--smrt-surface-control);
  }
  .smrt-advanced-styles__editor:focus-within {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  pre, textarea {
    tab-size: 2;
    font: 500 .9rem/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: normal;
  }
  pre {
    color: var(--smrt-color-on-surface);
  }
  textarea {
    border: 0;
    background: transparent;
    color: transparent;
    caret-color: var(--smrt-color-on-surface);
    -webkit-text-fill-color: transparent;
  }
  textarea::selection {
    background: color-mix(in srgb, var(--smrt-color-primary) 28%, transparent);
  }
  textarea:focus {
    outline: none;
  }
  textarea::placeholder {
    color: var(--smrt-color-on-surface-variant);
    -webkit-text-fill-color: var(--smrt-color-on-surface-variant);
  }
  /* Syntax roles on the theme's own colours, so they follow the scheme and
  the chosen brand instead of a fixed light/dark palette. */
  .smrt-advanced-styles__selector {
    color: var(--smrt-color-tertiary);
  }
  .smrt-advanced-styles__property {
    color: var(--smrt-color-primary);
  }
  .smrt-advanced-styles__value {
    color: var(--smrt-color-secondary);
  }
  .smrt-advanced-styles__comment {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-advanced-styles__punctuation {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-advanced-styles__help {
    font-size: .9rem;
  }
}

</style>
