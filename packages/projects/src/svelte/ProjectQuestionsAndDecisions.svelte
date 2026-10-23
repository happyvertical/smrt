<script lang="ts">
import {
  createAnalyticsTransitions,
  getAnalyticsContext,
} from '@happyvertical/smrt-ui/analytics';
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './i18n.js';
import type {
  ProjectDecisionResolveInput,
  ProjectDecisionView,
  ProjectQuestionAnswerInput,
  ProjectQuestionView,
} from './project-governance-types.js';

export interface Props {
  /** Authorized question projections to display and resolve. */
  questions?: ProjectQuestionView[];
  /** Authorized decision projections with their available choices. */
  decisions?: ProjectDecisionView[];
  /** Disable resolution submissions while the host saves a change. */
  busy?: boolean;
  /** Save an explicit owner answer with the observed revision. */
  onanswer?: (input: ProjectQuestionAnswerInput) => void | Promise<void>;
  /** Save a selected outcome and rationale with the observed revision. */
  ondecide?: (input: ProjectDecisionResolveInput) => void | Promise<void>;
}

let {
  questions = [],
  decisions = [],
  busy = false,
  onanswer,
  ondecide,
}: Props = $props();

const { t } = useI18n();
const analytics = getAnalyticsContext();
const observeQuestions = createAnalyticsTransitions(analytics);
const observeDecisions = createAnalyticsTransitions(analytics);
$effect(() =>
  observeQuestions(questions, 'open', {
    answered: 'project_question_answered',
  }),
);
$effect(() =>
  observeDecisions(decisions, 'open', { decided: 'project_decision_resolved' }),
);

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
      <h2>{t(M['projects.governance.questions'])}</h2>
      <p>{t(M['projects.governance.questions_description'])}</p>
    </div>
    <span>{t(M['projects.governance.open_count'], { count: questions.filter((item) => item.status === 'open').length })}</span>
  </div>

  {#if questions.length === 0}
    <p class="empty">{t(M['projects.governance.questions_empty'])}</p>
  {:else}
    <div class="items">
      {#each questions as question (question.id)}
        <article id={`question-${question.id}`}>
          <header>
            <div>
              <h3>{question.prompt}</h3>
              {#if question.ownerLabel}<small>{t(M['projects.governance.owner'])} {question.ownerLabel}</small>{/if}
            </div>
            <span class="status">{question.status}</span>
          </header>
          {#if question.answer}<p class="response">{question.answer}</p>{/if}
          {#if question.contextReferences?.length}
            <ul class="references" aria-label={t(M['projects.governance.question_context'])}>
              {#each question.contextReferences as reference (`${reference.kind}:${reference.ref}`)}
                <li>{reference.label ?? reference.ref} <small>{reference.kind}</small></li>
              {/each}
            </ul>
          {/if}
          {#if question.status === 'open' && question.canResolve}
            <Form onsubmit={(event) => submitAnswer(event, question)}>
              <label for={`answer-${question.id}`}>{t(M['projects.governance.answer'])}</label>
              <Textarea id={`answer-${question.id}`} name="answer" required></Textarea>
              <Button type="submit" disabled={busy}>{t(M['projects.governance.save_answer'])}</Button>
            </Form>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <div class="section-heading decisions-heading">
    <div>
      <h2>{t(M['projects.governance.decisions'])}</h2>
      <p>{t(M['projects.governance.decisions_description'])}</p>
    </div>
    <span>{t(M['projects.governance.open_count'], { count: decisions.filter((item) => item.status === 'open').length })}</span>
  </div>

  {#if decisions.length === 0}
    <p class="empty">{t(M['projects.governance.decisions_empty'])}</p>
  {:else}
    <div class="items">
      {#each decisions as decision (decision.id)}
        <article id={`decision-${decision.id}`}>
          <header>
            <div>
              <h3>{decision.question}</h3>
              {#if decision.ownerLabel}<small>{t(M['projects.governance.owner'])} {decision.ownerLabel}</small>{/if}
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
            <ul class="references" aria-label={t(M['projects.governance.decision_context'])}>
              {#each decision.contextReferences as reference (`${reference.kind}:${reference.ref}`)}
                <li>{reference.label ?? reference.ref} <small>{reference.kind}</small></li>
              {/each}
            </ul>
          {/if}
          {#if decision.status === 'open' && decision.canResolve}
            <Form onsubmit={(event) => submitDecision(event, decision)}>
              {#if decision.options?.length}
                <label for={`outcome-${decision.id}`}>{t(M['projects.governance.outcome'])}</label>
                <Select id={`outcome-${decision.id}`} name="outcome" required>
                  <option value="">{t(M['projects.governance.choose_option'])}</option>
                  {#each decision.options as option (option.id)}
                    <option value={option.id}>{option.label}</option>
                  {/each}
                </Select>
              {:else}
                <label for={`outcome-${decision.id}`}>{t(M['projects.governance.outcome'])}</label>
                <Input id={`outcome-${decision.id}`} name="outcome" required />
              {/if}
              <label for={`rationale-${decision.id}`}>{t(M['projects.governance.rationale'])}</label>
              <Textarea id={`rationale-${decision.id}`} name="rationale"></Textarea>
              <Button type="submit" disabled={busy}>{t(M['projects.governance.record_decision'])}</Button>
            </Form>
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
  article header > div, article :global(form), .response { display: grid; gap: var(--smrt-spacing-2); }
  .status { font-size: var(--smrt-typography-label-medium-size); text-transform: capitalize; }
  .references { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); list-style: none; margin: 0; padding: 0; }
  .references li { background: var(--smrt-color-surface-container); border-radius: var(--smrt-radius-small); padding: var(--smrt-spacing-1) var(--smrt-spacing-2); }
  article :global(form) { border-top: var(--smrt-hairline); padding-top: var(--smrt-spacing-3); }
  article :global(form button) { justify-self: end; }
  @media (max-width: 40rem) { .section-heading, article header { align-items: stretch; flex-direction: column; } .section-heading > span, .status { align-self: start; } }
}
</style>
