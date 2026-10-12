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

<section class="advanced-styles" aria-labelledby="advanced-styles-title">
  <a class="back" href={backHref} data-sveltekit-reload={backHref.startsWith('/') ? true : undefined}>← Back to Theme</a>
  <div class="heading">
    <div>
      <h1 id="advanced-styles-title">Advanced Styles</h1>
      <p>Make this app your own with CSS. Changes appear as you type and are saved with your cookbook.</p>
    </div>
    <span class="live"><span aria-hidden="true"></span>Live preview</span>
  </div>
  {#if pending}
    <div class="pending" role="status">
      <p>This cookbook brings its own CSS. It is not applied until you review and approve it.</p>
      <button type="button" onclick={() => approveCustomCss(css)}>Apply these styles</button>
    </div>
  {/if}
  <label for="advanced-css">Custom CSS</label>
  <div class="editor">
    <pre bind:this={highlight} aria-hidden="true"><code>{#each tokens as token}<span class:comment={token.kind === 'comment'} class:selector={token.kind === 'selector'} class:property={token.kind === 'property'} class:value={token.kind === 'value'} class:punctuation={token.kind === 'punctuation'}>{token.text}</span>{/each}</code></pre>
    <textarea id="advanced-css" bind:this={editor} value={draftCss} oninput={(event) => editCss(event.currentTarget.value)}
      onscroll={syncScroll} spellcheck="false" maxlength="65536" wrap="off"
      placeholder="/* Add your app styles here */" aria-describedby="advanced-css-help"></textarea>
  </div>
  <p id="advanced-css-help" class="help">Ask your agent to write styles here, or start with a selector like <code>.smrt-admin-shell</code>. Clearing the editor removes your custom styles. Styles apply only inside the app shell and cannot load files from other sites; add <code>?styles=off</code> to the address to turn them off.</p>
</section>

<style>
  .advanced-styles { display: grid; gap: 1rem; max-inline-size: 72rem; }
  .pending { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); }
  .pending p { margin: 0; }
  .back { color: var(--smrt-color-primary); font-weight: 700; text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .heading { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
  h1, p { margin: 0; }
  h1 { font-size: clamp(1.5rem, 3vw, 2rem); }
  .heading p, .help { color: var(--smrt-color-on-surface-variant); }
  .heading p { margin-top: .35rem; }
  .live { display: inline-flex; align-items: center; gap: .4rem; flex: none; padding: .4rem .65rem; border-radius: 2rem; background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); font-size: .8rem; font-weight: 700; }
  .live span { inline-size: .5rem; block-size: .5rem; border-radius: 50%; background: var(--smrt-color-primary); }
  label { font-weight: 700; }
  .editor { position: relative; min-block-size: 24rem; border: 1px solid var(--smrt-color-outline); border-radius: .75rem; background: var(--smrt-color-surface-container-lowest); overflow: hidden; }
  .editor:focus-within { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  pre, textarea { box-sizing: border-box; position: absolute; inset: 0; inline-size: 100%; block-size: 100%; margin: 0; padding: 1rem; overflow: auto; white-space: pre; tab-size: 2; font: 500 .9rem/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: normal; }
  pre { pointer-events: none; color: var(--smrt-color-on-surface); }
  textarea { z-index: 1; border: 0; resize: none; background: transparent; color: transparent; caret-color: var(--smrt-color-on-surface); -webkit-text-fill-color: transparent; }
  textarea::selection { background: color-mix(in srgb, var(--smrt-color-primary) 28%, transparent); }
  textarea:focus { outline: none; }
  textarea::placeholder { color: var(--smrt-color-on-surface-variant); -webkit-text-fill-color: var(--smrt-color-on-surface-variant); }
  .selector { color: #b452ab; }
  .property { color: #3577b5; }
  .value { color: #a36712; }
  .comment { color: #648276; }
  .punctuation { color: var(--smrt-color-on-surface-variant); }
  .help { font-size: .9rem; }
  @media (prefers-color-scheme: dark) {
    .selector { color: #e2a4de; }
    .property { color: #9bcaff; }
    .value { color: #f0c27e; }
    .comment { color: #9bbfac; }
  }
  @media (max-width: 42rem) { .heading { display: grid; } .live { justify-self: start; } }
</style>
