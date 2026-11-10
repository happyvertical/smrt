<script lang="ts">
import { Form, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { tick } from 'svelte';
import { M } from './i18n.js';
import type {
  ProjectDecisionResolveInput,
  ProjectDecisionView,
  ProjectInterviewAdvanceDetail,
  ProjectInterviewFraming,
  ProjectQuestionAnswerInput,
  ProjectQuestionView,
} from './project-governance-types.js';

export interface Props {
  /** Authorized questions, in the order the host wants them asked. */
  questions?: ProjectQuestionView[];
  /** Authorized decisions, asked after the questions in the host's order. */
  decisions?: ProjectDecisionView[];
  /** Disable submissions and navigation while the host saves a change. */
  busy?: boolean;
  /** Plain-language framing keyed by question or decision id. */
  framing?: Record<string, ProjectInterviewFraming>;
  /**
   * Zero-based record to open first (e.g. a resumed position). Defaults to the
   * first open record; read once on mount.
   */
  startIndex?: number;
  /** Save an explicit answer with the observed revision. */
  onanswer?: (input: ProjectQuestionAnswerInput) => void | Promise<void>;
  /** Save a selected outcome and optional rationale with the observed revision. */
  ondecide?: (input: ProjectDecisionResolveInput) => void | Promise<void>;
  /** Called whenever the interview moves to another record or completes. */
  onadvance?: (detail: ProjectInterviewAdvanceDetail) => void;
}

type Step =
  | { kind: 'question'; key: string; record: ProjectQuestionView }
  | { kind: 'decision'; key: string; record: ProjectDecisionView };

let {
  questions = [],
  decisions = [],
  busy = false,
  framing = {},
  startIndex,
  onanswer,
  ondecide,
  onadvance,
}: Props = $props();

const { t } = useI18n();

const steps = $derived<Step[]>([
  ...questions.map((record) => ({
    kind: 'question' as const,
    key: `question:${record.id}`,
    record,
  })),
  ...decisions.map((record) => ({
    kind: 'decision' as const,
    key: `decision:${record.id}`,
    record,
  })),
]);
const total = $derived(steps.length);
const answeredCount = $derived(
  steps.filter((step) => step.record.status !== 'open').length,
);
const openCount = $derived(total - answeredCount);

function firstOpenFrom(from: number): number {
  for (let index = Math.max(0, from); index < steps.length; index++) {
    if (steps[index].record.status === 'open') return index;
  }
  return steps.length;
}

function initialCursor(): { key: string | null; index: number } {
  const index =
    startIndex === undefined
      ? firstOpenFrom(0)
      : Math.min(Math.max(0, Math.trunc(startIndex)), steps.length);
  return { key: steps[index]?.key ?? null, index };
}

// Track the current record by identity so host re-ordering or removal of an
// answered record never jumps the person to an unrelated question.
let cursor = $state(initialCursor());
const position = $derived.by(() => {
  const found = cursor.key
    ? steps.findIndex((step) => step.key === cursor.key)
    : -1;
  return found >= 0 ? found : Math.min(cursor.index, total);
});
const current = $derived<Step | null>(steps[position] ?? null);

// Keep the fallback index aligned with the record's latest position so a later
// withdrawal resumes from where that record actually was.
$effect(() => {
  if (
    cursor.key &&
    steps[position]?.key === cursor.key &&
    cursor.index !== position
  ) {
    cursor = { key: cursor.key, index: position };
  }
});

let pendingKey = $state<string | null>(null);
let selections = $state<Record<string, string>>({});
let heading = $state<HTMLElement | null>(null);
let focusRequested = false;

// Motion is opt-in: assume reduced motion until the browser says otherwise.
let reducedMotion = $state(true);
$effect(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion = query.matches;
  const update = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
  };
  query.addEventListener?.('change', update);
  return () => query.removeEventListener?.('change', update);
});

function moveTo(
  index: number,
  reason: ProjectInterviewAdvanceDetail['reason'],
) {
  const next = Math.min(Math.max(0, index), total);
  const step = steps[next] ?? null;
  cursor = { key: step?.key ?? null, index: next };
  pendingKey = null;
  focusRequested = true;
  onadvance?.({
    index: next,
    total,
    id: step?.record.id ?? null,
    kind: step?.kind ?? null,
    reason,
  });
}

// Advance once the host persists the submitted record (status leaves `open` or
// the record is withdrawn); a failed save keeps the person on the question.
$effect(() => {
  if (!pendingKey) return;
  const index = steps.findIndex((step) => step.key === pendingKey);
  if (index >= 0 && steps[index].record.status === 'open') return;
  const from = index >= 0 ? index + 1 : Math.min(cursor.index, total);
  moveTo(firstOpenFrom(from), 'answered');
});

$effect(() => {
  if (!heading || !focusRequested) return;
  focusRequested = false;
  const target = heading;
  void tick().then(() => target.focus());
});

function sortedOptions<T extends { id: string; recommended?: boolean }>(
  options: T[] | undefined,
  recommendedId: string | undefined,
  reserveOther: boolean,
): Array<T & { isRecommended: boolean }> {
  return (
    (options ?? [])
      // `other` is reserved for the question form's free-text choice only.
      .filter((option) => !reserveOther || option.id !== 'other')
      .map((option) => ({
        ...option,
        isRecommended: recommendedId
          ? option.id === recommendedId
          : Boolean(option.recommended),
      }))
      .sort((a, b) => Number(b.isRecommended) - Number(a.isRecommended))
  );
}

function submitAnswer(event: SubmitEvent, question: ProjectQuestionView) {
  event.preventDefault();
  if (busy) return;
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const selectedOptionId = String(form.get('selectedOptionId') ?? '');
  const structured = Boolean(question.options?.length);
  if (structured && !selectedOptionId) return;
  const option = question.options?.find(
    (entry) => entry.id === selectedOptionId,
  );
  const answer =
    structured && selectedOptionId !== 'other'
      ? (option?.label ?? '')
      : String(form.get('answer') ?? '').trim();
  if (!answer) return;
  pendingKey = `question:${question.id}`;
  void onanswer?.({
    id: question.id,
    answer,
    expectedRevision: question.revision,
    ...(structured ? { selectedOptionId } : {}),
  });
}

function submitDecision(event: SubmitEvent, decision: ProjectDecisionView) {
  event.preventDefault();
  if (busy) return;
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const outcome = String(form.get('outcome') ?? '').trim();
  if (!outcome) return;
  pendingKey = `decision:${decision.id}`;
  void ondecide?.({
    id: decision.id,
    outcome,
    rationale: String(form.get('rationale') ?? '').trim(),
    expectedRevision: decision.revision,
  });
}
</script>

<section
  class="interview"
  aria-label={t(M['projects.interview.aria'])}
  data-smrt-component="ProjectInterview"
  data-motion={reducedMotion ? 'off' : 'on'}
>
  {#if total === 0}
    <p class="empty">{t(M['projects.interview.empty'])}</p>
  {:else}
    <div class="progress">
      <p aria-live="polite">
        {#if current}{t(M['projects.interview.progress'], { current: position + 1, total })} · {/if}{t(M['projects.interview.answered_count'], { answered: answeredCount, total })}
      </p>
      <progress value={answeredCount} max={total} aria-label={t(M['projects.interview.answered_count'], { answered: answeredCount, total })}></progress>
    </div>

    {#key current?.key ?? 'complete'}
      <article class="step" data-interview-step={current?.key ?? 'complete'}>
        {#if current}
          {@const frame = framing[current.record.id] ?? {}}
          {@const prompt = current.kind === 'question' ? current.record.prompt : current.record.question}
          <h2 tabindex="-1" bind:this={heading}>{prompt}</h2>
          {#if frame.why}
            <div class="framing">
              <h3>{t(M['projects.interview.why'])}</h3>
              <p>{frame.why}</p>
            </div>
          {/if}
          {#if frame.unblocks?.length}
            <div class="framing">
              <h3 id={`unblocks-${current.key}`}>{t(M['projects.interview.unblocks'])}</h3>
              <ul aria-labelledby={`unblocks-${current.key}`}>
                {#each frame.unblocks as label, index (`${index}:${label}`)}
                  <li>{label}</li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if current.record.status !== 'open'}
            <div class="recorded">
              <h3>{t(M['projects.interview.recorded'])}</h3>
              {#if current.kind === 'question'}
                <p>{current.record.answer}</p>
              {:else}
                {@const decision = current.record}
                <p>
                  <strong>{decision.options?.find((option) => option.id === decision.outcome)?.label ?? decision.outcome}</strong>
                  {#if decision.rationale}<span>{decision.rationale}</span>{/if}
                </p>
              {/if}
            </div>
          {:else if !current.record.canResolve}
            <p class="empty">{t(M['projects.interview.not_yours'])}</p>
          {:else if current.kind === 'question'}
            {@const question = current.record}
            {@const options = sortedOptions(question.options, frame.recommendedOptionId, true)}
            <Form onsubmit={(event) => submitAnswer(event, question)}>
              {#if options.length}
                <fieldset disabled={busy}>
                  <legend>{t(M['projects.interview.your_answer'])}</legend>
                  {#each options as option (option.id)}
                    <label class="choice" class:recommended={option.isRecommended}>
                      <Input type="radio" name="selectedOptionId" value={option.id} required interaction={false} checked={selections[current.key] === option.id} onchange={() => (selections[current.key] = option.id)} />
                      <span>{option.label}{#if option.isRecommended} <strong>{t(M['projects.governance.recommended'])}</strong>{/if}
                        {#if option.description}<small>{option.description}</small>{/if}
                      </span>
                    </label>
                  {/each}
                  <label class="choice">
                    <Input type="radio" name="selectedOptionId" value="other" required interaction={false} checked={selections[current.key] === 'other'} onchange={() => (selections[current.key] = 'other')} />
                    <span>{t(M['projects.governance.other'])}</span>
                  </label>
                  <label for={`interview-answer-${question.id}`}>{t(M['projects.governance.other_answer'])}</label>
                  <Textarea id={`interview-answer-${question.id}`} name="answer" required={selections[current.key] === 'other'}></Textarea>
                </fieldset>
              {:else}
                <label for={`interview-answer-${question.id}`}>{t(M['projects.interview.your_answer'])}</label>
                <Textarea id={`interview-answer-${question.id}`} name="answer" required disabled={busy}></Textarea>
              {/if}
              <Button type="submit" disabled={busy}>{t(M['projects.interview.submit'])}</Button>
            </Form>
          {:else}
            {@const decision = current.record}
            {@const options = sortedOptions(decision.options, frame.recommendedOptionId, false)}
            <Form onsubmit={(event) => submitDecision(event, decision)}>
              {#if options.length}
                <fieldset disabled={busy}>
                  <legend>{t(M['projects.interview.your_choice'])}</legend>
                  {#each options as option (option.id)}
                    <label class="choice" class:recommended={option.isRecommended}>
                      <Input type="radio" name="outcome" value={option.id} required interaction={false} />
                      <span>{option.label}{#if option.isRecommended} <strong>{t(M['projects.governance.recommended'])}</strong>{/if}
                        {#if option.description}<small>{option.description}</small>{/if}
                      </span>
                    </label>
                  {/each}
                </fieldset>
              {:else}
                <label for={`interview-outcome-${decision.id}`}>{t(M['projects.interview.your_choice'])}</label>
                <Input id={`interview-outcome-${decision.id}`} name="outcome" required disabled={busy} />
              {/if}
              <label for={`interview-rationale-${decision.id}`}>{t(M['projects.interview.notes'])}</label>
              <Textarea id={`interview-rationale-${decision.id}`} name="rationale" disabled={busy}></Textarea>
              <Button type="submit" disabled={busy}>{t(M['projects.interview.submit'])}</Button>
            </Form>
          {/if}

          <nav class="navigation" aria-label={t(M['projects.interview.navigation'])}>
            <Button type="button" variant="ghost" disabled={busy || position === 0} onclick={() => moveTo(position - 1, 'back')}>{t(M['projects.interview.back'])}</Button>
            {#if current.record.status === 'open'}
              <Button type="button" variant="ghost" disabled={busy} onclick={() => moveTo(position + 1, 'skip')}>{t(M['projects.interview.skip'])}</Button>
            {:else}
              <Button type="button" variant="ghost" disabled={busy} onclick={() => moveTo(firstOpenFrom(position + 1), 'next')}>{t(M['projects.interview.next'])}</Button>
            {/if}
          </nav>
        {:else if openCount === 0}
          <h2 tabindex="-1" bind:this={heading}>{t(M['projects.interview.complete_title'])}</h2>
          <p>{t(M['projects.interview.complete_description'])}</p>
          <nav class="navigation" aria-label={t(M['projects.interview.navigation'])}>
            <Button type="button" variant="ghost" disabled={busy} onclick={() => moveTo(total - 1, 'back')}>{t(M['projects.interview.back'])}</Button>
          </nav>
        {:else}
          <h2 tabindex="-1" bind:this={heading}>{t(M['projects.interview.remaining_title'])}</h2>
          <p>{t(M['projects.interview.remaining_description'], { count: openCount })}</p>
          <nav class="navigation" aria-label={t(M['projects.interview.navigation'])}>
            <Button type="button" variant="ghost" disabled={busy} onclick={() => moveTo(total - 1, 'back')}>{t(M['projects.interview.back'])}</Button>
            <Button type="button" disabled={busy} onclick={() => moveTo(firstOpenFrom(0), 'review')}>{t(M['projects.interview.review_skipped'])}</Button>
          </nav>
        {/if}
      </article>
    {/key}
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .interview { display: grid; gap: var(--smrt-spacing-4); max-width: 40rem; }
  .progress { display: grid; gap: var(--smrt-spacing-2); }
  .progress p, .step h2, .step h3, .step p { margin: 0; }
  .progress p, .empty, .choice small { color: var(--smrt-color-on-surface-variant); }
  .progress progress { width: 100%; }
  .step { border: var(--smrt-hairline); border-radius: var(--smrt-radius-medium); display: grid; gap: var(--smrt-spacing-4); padding: var(--smrt-spacing-5); }
  .step h2:focus { outline: none; }
  .step h2:focus-visible { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
  .framing { display: grid; gap: var(--smrt-spacing-1); }
  .framing h3, .recorded h3 { font-size: var(--smrt-typography-label-large-size); }
  .framing ul { margin: 0; padding-inline-start: var(--smrt-spacing-5); }
  .recorded p { display: grid; gap: var(--smrt-spacing-1); }
  .step :global(form) { display: grid; gap: var(--smrt-spacing-3); }
  .step :global(form button[type='submit']) { justify-self: start; }
  fieldset { display: grid; gap: var(--smrt-spacing-2); border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { margin-bottom: var(--smrt-spacing-2); padding: 0; }
  .choice { display: flex; align-items: start; gap: var(--smrt-spacing-2); }
  .choice.recommended { font-weight: var(--smrt-typography-weight-medium, 500); }
  .choice :global(input[type='radio']) { width: auto; min-height: auto; padding: 0; }
  .choice small { display: block; }
  .navigation { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); justify-content: space-between; }
  @media (prefers-reduced-motion: no-preference) {
    .interview[data-motion='on'] .step { animation: smrt-interview-enter 160ms ease-out; }
  }
  @keyframes smrt-interview-enter { from { opacity: 0; transform: translateY(0.25rem); } to { opacity: 1; transform: none; } }
}
</style>
