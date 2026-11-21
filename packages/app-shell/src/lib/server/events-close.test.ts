import { expect, it, vi } from 'vitest';

it('closeAllStreams ends every registered stream once and refuses new ones', async () => {
  vi.resetModules();
  const events = await import('./events.ts');
  const a = vi.fn();
  const b = vi.fn();
  events.onStreamsClosed(a);
  const offB = events.onStreamsClosed(b);
  offB();
  expect(events.streamsClosed()).toBe(false);
  events.closeAllStreams();
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
  expect(events.streamsClosed()).toBe(true);
  // In-process subscribers keep working while the process shuts down.
  const seen = vi.fn();
  events.subscribe(seen);
  events.publish({ type: 'records', target: 'live', model: null });
  expect(seen).toHaveBeenCalledOnce();
  events.closeAllStreams();
  expect(a).toHaveBeenCalledOnce();
});
