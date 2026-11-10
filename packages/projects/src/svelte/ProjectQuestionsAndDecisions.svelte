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

let selections = $state<Record<string, string>>({});

function submitAnswer(event: SubmitEvent, question: ProjectQuestionView) {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const selectedOptionId = String(form.get('selectedOptionId') ?? '');
  const option = question.options?.find(
    (entry) => entry.id === selectedOptionId,
  );
  const structured = Boolean(question.options?.length);
  if (structured && !selectedOptionId) return;
  const answer =
    structured && selectedOptionId !== 'other'
      ? (option?.label ?? '')
      : String(form.get('answer') ?? '').trim();
  if (answer)
    onanswer?.({
      id: question.id,
      answer,
      expectedRevision: question.revision,
      ...(structured ? { selectedOptionId } : {}),
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

<section class="smrt-project-questions-and-decisions__root" data-smrt-component="ProjectQuestionsAndDecisions">
  <div class="smrt-project-questions-and-decisions__heading" data-smrt-part="heading">
    <div>
      <h2>{t(M['projects.governance.questions'])}</h2>
      <p>{t(M['projects.governance.questions_description'])}</p>
    </div>
    <span>{t(M['projects.governance.open_count'], { count: questions.filter((item) => item.status === 'open').length })}</span>
  </div>

  {#if questions.length === 0}
    <p class="smrt-project-questions-and-decisions__empty" data-smrt-part="empty">{t(M['projects.governance.questions_empty'])}</p>
  {:else}
    <div class="smrt-project-questions-and-decisions__items" data-smrt-part="list">
      {#each questions as question (question.id)}
        <article id={`question-${question.id}`}>
          <header>
            <div>
              <h3>{question.prompt}</h3>
              {#if question.ownerLabel}<small>{t(M['projects.governance.owner'])} {question.ownerLabel}</small>{/if}
            </div>
            <span class="smrt-project-questions-and-decisions__status" data-smrt-part="status">{question.status}</span>
          </header>
          {#if question.answer}<p class="smrt-project-questions-and-decisions__response" data-smrt-part="body">{question.answer}</p>{/if}
          {#if question.contextReferences?.length}
            <ul class="smrt-project-questions-and-decisions__references" data-smrt-part="references" aria-label={t(M['projects.governance.question_context'])}>
              {#each question.contextReferences as reference (`${reference.kind}:${reference.ref}`)}
                <li>{reference.label ?? reference.ref} <small>{reference.kind}</small></li>
              {/each}
            </ul>
          {/if}
          {#if question.status === 'open' && question.canResolve}
            <Form onsubmit={(event) => submitAnswer(event, question)}>
              {#if question.options?.length}
                <fieldset disabled={busy}>
                  <legend>{t(M['projects.governance.answer'])}</legend>
                  {#each question.options.filter((option) => option.id !== 'other') as option (option.id)}
                    <label class="smrt-project-questions-and-decisions__choice" data-smrt-part="choice">
                      <Input type="radio" name="selectedOptionId" value={option.id} required interaction={false} checked={selections[question.id] === option.id} onchange={() => selections[question.id] = option.id} />
                      <span>{option.label}{#if option.recommended} <strong>{t(M['projects.governance.recommended'])}</strong>{/if}
                        {#if option.description}<small>{option.description}</small>{/if}
                      </span>
                    </label>
                  {/each}
                  <label class="smrt-project-questions-and-decisions__choice" data-smrt-part="choice">
                    <Input type="radio" name="selectedOptionId" value="other" required interaction={false} checked={selections[question.id] === 'other'} onchange={() => selections[question.id] = 'other'} />
                    <span>{t(M['projects.governance.other'])}</span>
                  </label>
                  <label for={`answer-${question.id}`}>{t(M['projects.governance.other_answer'])}</label>
                  <Textarea id={`answer-${question.id}`} name="answer" required={selections[question.id] === 'other'}></Textarea>
                </fieldset>
              {:else}
                <label for={`answer-${question.id}`}>{t(M['projects.governance.answer'])}</label>
                <Textarea id={`answer-${question.id}`} name="answer" required></Textarea>
              {/if}
              <Button type="submit" disabled={busy}>{t(M['projects.governance.save_answer'])}</Button>
            </Form>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <div class="smrt-project-questions-and-decisions__heading smrt-project-questions-and-decisions__decisions-heading" data-smrt-part="heading">
    <div>
      <h2>{t(M['projects.governance.decisions'])}</h2>
      <p>{t(M['projects.governance.decisions_description'])}</p>
    </div>
    <span>{t(M['projects.governance.open_count'], { count: decisions.filter((item) => item.status === 'open').length })}</span>
  </div>

  {#if decisions.length === 0}
    <p class="smrt-project-questions-and-decisions__empty" data-smrt-part="empty">{t(M['projects.governance.decisions_empty'])}</p>
  {:else}
    <div class="smrt-project-questions-and-decisions__items" data-smrt-part="list">
      {#each decisions as decision (decision.id)}
        <article id={`decision-${decision.id}`}>
          <header>
            <div>
              <h3>{decision.question}</h3>
              {#if decision.ownerLabel}<small>{t(M['projects.governance.owner'])} {decision.ownerLabel}</small>{/if}
            </div>
            <span class="smrt-project-questions-and-decisions__status" data-smrt-part="status">{decision.status}</span>
          </header>
          {#if decision.outcome}
            <p class="smrt-project-questions-and-decisions__response" data-smrt-part="body">
              <strong>{decision.options?.find((option) => option.id === decision.outcome)?.label ?? decision.outcome}</strong>
              {#if decision.rationale}<span>{decision.rationale}</span>{/if}
            </p>
          {/if}
          {#if decision.contextReferences?.length}
            <ul class="smrt-project-questions-and-decisions__references" data-smrt-part="references" aria-label={t(M['projects.governance.decision_context'])}>
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
@layer smrt.structure {
  .smrt-project-questions-and-decisions__root {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .smrt-project-questions-and-decisions__heading {
    align-items: end;
    display: flex;
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }
  .smrt-project-questions-and-decisions__heading h2, .smrt-project-questions-and-decisions__heading p, article h3, .smrt-project-questions-and-decisions__response {
    margin: 0;
  }
  .smrt-project-questions-and-decisions__heading > span, .smrt-project-questions-and-decisions__status {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    white-space: nowrap;
  }
  .smrt-project-questions-and-decisions__decisions-heading {
    margin-top: var(--smrt-spacing-5);
  }
  .smrt-project-questions-and-decisions__items {
    display: grid;
    gap: var(--smrt-spacing-3);
  }
  article {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
  }
  article header {
    align-items: start;
    display: flex;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }
  article header > div, article :global(form), .smrt-project-questions-and-decisions__response {
    display: grid;
    gap: var(--smrt-spacing-2);
  }
  fieldset {
    display: grid;
    gap: var(--smrt-spacing-2);
    padding: 0;
    min-width: 0;
  }
  .smrt-project-questions-and-decisions__choice {
    display: flex;
    align-items: start;
    gap: var(--smrt-spacing-2);
  }
  .smrt-project-questions-and-decisions__choice :global(input[type='radio']) {
    width: auto;
    min-height: auto;
    padding: 0;
  }
  .smrt-project-questions-and-decisions__choice small {
    display: block;
  }
  .smrt-project-questions-and-decisions__references {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-project-questions-and-decisions__references li {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  article :global(form) {
    padding-top: var(--smrt-spacing-3);
  }
  article :global(form button) {
    justify-self: end;
  }
  @media (max-width: 40rem) {
    .smrt-project-questions-and-decisions__heading, article header {
      align-items: stretch;
      flex-direction: column;
    }
    .smrt-project-questions-and-decisions__heading > span, .smrt-project-questions-and-decisions__status {
      align-self: start;
    }
  }
}

@layer smrt.theme {
  .smrt-project-questions-and-decisions__heading p, article small, .smrt-project-questions-and-decisions__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-project-questions-and-decisions__heading > span, .smrt-project-questions-and-decisions__status {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
  }
  article {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
  }
  fieldset {
    border: 0;
  }
  .smrt-project-questions-and-decisions__status {
    font-size: var(--smrt-typography-label-medium-size);
    text-transform: capitalize;
  }
  .smrt-project-questions-and-decisions__references li {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-small);
  }
  article :global(form) {
    border-top: var(--smrt-hairline);
  }
}

</style>
