/** `requestAssistant`: a bubbling, cancelable ask that reports who took it. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_REQUEST_EVENT,
  type AssistantRequestDetail,
  requestAssistant,
} from '../assistant-request.js';

afterEach(() => document.body.replaceChildren());

describe('requestAssistant', () => {
  it('is not taken when no assistant listens', () => {
    const button = document.createElement('button');
    document.body.append(button);
    expect(requestAssistant(button, { prompt: 'sales by month' })).toBe(false);
  });

  it('bubbles the prompt to a listener that takes it', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const seen: string[] = [];
    const take = (event: Event) => {
      seen.push((event as CustomEvent<AssistantRequestDetail>).detail.prompt);
      event.preventDefault();
    };
    document.addEventListener(ASSISTANT_REQUEST_EVENT, take);
    try {
      expect(requestAssistant(button, { prompt: 'sales by month' })).toBe(true);
      expect(seen).toEqual(['sales by month']);
    } finally {
      document.removeEventListener(ASSISTANT_REQUEST_EVENT, take);
    }
  });
});
