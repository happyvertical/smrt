<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  ProjectDecisionResolveInput,
  ProjectDecisionView,
  ProjectQuestionAnswerInput,
  ProjectQuestionView,
} from './project-governance-types.js';

export interface Props {
  questions?: ProjectQuestionView[];
  decisions?: ProjectDecisionView[];
  busy?: boolean;
  onanswer?: (input: ProjectQuestionAnswerInput) => void | Promise<void>;
  ondecide?: (input: ProjectDecisionResolveInput) => void | Promise<void>;
}

let {
  questions = [],
  decisions = [],
  busy = false,
  onanswer,
  ondecide,
}: Props = $props();

function submitAnswer(event: SubmitEvent, question: ProjectQuestionView) {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const answer = String(form.get('answer') ?? '').trim();
  if (answer)
    onanswer?.({
      id: question.id,
      answer,
      expectedRevision: question.revision,
    });
}

function submitDecision(event: SubmitEvent, decision: ProjectDecisionView) {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const outcome = String(form.get('outcome') ?? '').trim();
  if (!outcome) return;
  ondecide?.({
    id: decision.id,
    outcome,
    rationale: String(form.get('rationale') ?? '').trim(),
    expectedRevision: decision.revision,
  });
}
</script>

<section class="governance" data-smrt-component="ProjectQuestionsAndDecisions">
  <div class="section-heading">
    <div>
      <h2>Questions</h2>
      <p>Facts the project still needs from its owners.</p>
    </div>
    <span>{questions.filter((item) => item.status === 'open').length} open</span>
  </div>

  {#if questions.length === 0}
    <p class="empty">No project questions are waiting.</p>
  {:else}
    <div class="items">
      {#each questions as question (question.id)}
        <article id={`question-${question.id}`}>
          <header>
            <div>
              <h3>{question.prompt}</h3>
              {#if question.ownerLabel}<small>Owner: {question.ownerLabel}</small>{/if}
            </div>
            <span class="status">{question.status}</span>
          </header>
          {#if question.answer}<p class="response">{question.answer}</p>{/if}
          {#if question.contextReferences?.length}
            <ul class="references" aria-label="Question context">
              {#each question.contextReferences as reference (`${reference.kind}:${reference.ref}`)}
                <li>{reference.label ?? reference.ref} <small>{reference.kind}</small></li>
              {/each}
            </ul>
          {/if}
          {#if question.status === 'open' && question.canResolve}
            <form onsubmit={(event) => submitAnswer(event, question)}>
              <label for={`answer-${question.id}`}>Answer</label>
              <textarea id={`answer-${question.id}`} name="answer" required></textarea>
              <Button type="submit" disabled={busy}>Save answer</Button>
            </form>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <div class="section-heading decisions-heading">
    <div>
      <h2>Decisions</h2>
      <p>Choices that need an owner and a recorded outcome.</p>
    </div>
    <span>{decisions.filter((item) => item.status === 'open').length} open</span>
  </div>

  {#if decisions.length === 0}
    <p class="empty">No project decisions are waiting.</p>
  {:else}
    <div class="items">
      {#each decisions as decision (decision.id)}
        <article id={`decision-${decision.id}`}>
          <header>
            <div>
              <h3>{decision.question}</h3>
              {#if decision.ownerLabel}<small>Owner: {decision.ownerLabel}</small>{/if}
            </div>
            <span class="status">{decision.status}</span>
          </header>
          {#if decision.outcome}
            <p class="response">
              <strong>{decision.options?.find((option) => option.id === decision.outcome)?.label ?? decision.outcome}</strong>
              {#if decision.rationale}<span>{decision.rationale}</span>{/if}
            </p>
          {/if}
          {#if decision.contextReferences?.length}
            <ul class="references" aria-label="Decision context">
              {#each decision.contextReferences as reference (`${reference.kind}:${reference.ref}`)}
                <li>{reference.label ?? reference.ref} <small>{reference.kind}</small></li>
              {/each}
            </ul>
          {/if}
          {#if decision.status === 'open' && decision.canResolve}
            <form onsubmit={(event) => submitDecision(event, decision)}>
              {#if decision.options?.length}
                <label for={`outcome-${decision.id}`}>Outcome</label>
                <select id={`outcome-${decision.id}`} name="outcome" required>
                  <option value="">Select an option</option>
                  {#each decision.options as option (option.id)}
                    <option value={option.id}>{option.label}</option>
                  {/each}
                </select>
              {:else}
                <label for={`outcome-${decision.id}`}>Outcome</label>
                <input id={`outcome-${decision.id}`} name="outcome" required />
              {/if}
              <label for={`rationale-${decision.id}`}>Rationale</label>
              <textarea id={`rationale-${decision.id}`} name="rationale"></textarea>
              <Button type="submit" disabled={busy}>Record decision</Button>
            </form>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .governance { display: grid; gap: var(--smrt-spacing-4); }
  .section-heading { align-items: end; display: flex; justify-content: space-between; gap: var(--smrt-spacing-4); }
  .section-heading h2, .section-heading p, article h3, .response { margin: 0; }
  .section-heading p, article small, .empty { color: var(--smrt-color-on-surface-variant); }
  .section-heading > span, .status { border: var(--smrt-hairline); border-radius: var(--smrt-radius-full); padding: var(--smrt-spacing-1) var(--smrt-spacing-3); white-space: nowrap; }
  .decisions-heading { margin-top: var(--smrt-spacing-5); }
  .items { display: grid; gap: var(--smrt-spacing-3); }
  article { border: var(--smrt-hairline); border-radius: var(--smrt-radius-medium); display: grid; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-4); }
  article header { align-items: start; display: flex; justify-content: space-between; gap: var(--smrt-spacing-3); }
  article header > div, form, .response { display: grid; gap: var(--smrt-spacing-2); }
  .status { font-size: var(--smrt-typography-label-medium-size); text-transform: capitalize; }
  .references { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); list-style: none; margin: 0; padding: 0; }
  .references li { background: var(--smrt-color-surface-container); border-radius: var(--smrt-radius-small); padding: var(--smrt-spacing-1) var(--smrt-spacing-2); }
  form { border-top: var(--smrt-hairline); padding-top: var(--smrt-spacing-3); }
  form :global(button) { justify-self: end; }
  textarea { min-height: 5rem; resize: vertical; }
  input, select, textarea { background: var(--smrt-color-surface); border: var(--smrt-hairline); border-radius: var(--smrt-radius-small); color: inherit; padding: var(--smrt-spacing-2); }
  @media (max-width: 40rem) { .section-heading, article header { align-items: stretch; flex-direction: column; } .section-heading > span, .status { align-self: start; } }
}
</style>
