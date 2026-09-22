/**
 * `ModelStatusControl` — the user-facing model lifecycle surface.
 *
 * The states that matter here are the ones a user acts on: whether the model is
 * loaded, whether it can be loaded on this device at all, and what a download
 * is doing. The `unavailable` case is asserted explicitly because offering a
 * Load button on a device that cannot run the model is the failure this control
 * exists to prevent.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import type {
  InferenceBackend,
  InferenceBackendStatus,
  InferenceProgress,
} from '@happyvertical/smrt-web/ai';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelStatusControl from '../ModelStatusControl.svelte';

interface BackendDouble extends InferenceBackend {
  setStatus(status: InferenceBackendStatus): void;
  setProgress(progress: InferenceProgress | undefined): void;
  loadCalls: number;
  unloadCalls: number;
  loadImpl: () => Promise<void>;
}

function makeBackend(initial: Partial<InferenceBackend> = {}): BackendDouble {
  let status: InferenceBackendStatus = initial.status ?? 'idle';
  let progress: InferenceProgress | undefined;
  const listeners = new Set<() => void>();

  const backend: BackendDouble = {
    id: 'local',
    kind: 'local',
    get status() {
      return status;
    },
    get progress() {
      return progress;
    },
    loadCalls: 0,
    unloadCalls: 0,
    loadImpl: async () => {},
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener();
    },
    setProgress(next) {
      progress = next;
      for (const listener of [...listeners]) listener();
    },
    async load() {
      backend.loadCalls += 1;
      await backend.loadImpl();
    },
    async unload() {
      backend.unloadCalls += 1;
      status = 'idle';
      for (const listener of [...listeners]) listener();
    },
    async chat() {
      return { content: '' };
    },
    async *stream() {
      yield '';
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return backend;
}

describe('ModelStatusControl', () => {
  it('offers a load action when the model is not loaded', async () => {
    const backend = makeBackend({ status: 'idle' });
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Not loaded');
    await userEvent.click(screen.getByRole('button', { name: 'Load model' }));
    expect(backend.loadCalls).toBe(1);
  });

  it('offers a release action once the model is ready', async () => {
    const backend = makeBackend({ status: 'ready' });
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Ready');
    await userEvent.click(screen.getByRole('button', { name: 'Unload' }));
    expect(backend.unloadCalls).toBe(1);
  });

  it('hides the release action when the host opts out', () => {
    const backend = makeBackend({ status: 'ready' });
    render(ModelStatusControl, {
      props: { backend, allowUnload: false },
    });

    expect(screen.queryByRole('button', { name: 'Unload' })).toBeNull();
  });

  it('never offers a load action on a device that cannot run the model', () => {
    const backend = makeBackend({ status: 'unavailable' });
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Not available on this device',
    );
    // The point of the state: no affordance that cannot succeed.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/will use the server route/)).toBeInTheDocument();
  });

  it('offers no action for a backend that cannot load or unload', () => {
    // A route-kind backend defines neither method and always reports `ready`;
    // offering an Unload that silently does nothing is the same defect as
    // offering a Load on an unavailable device.
    const backend = makeBackend({ status: 'ready' });
    // "A backend with no unload" is not hypothetical: it is the route backend.
    delete backend.load;
    delete backend.unload;
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Ready');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers no load action for an idle backend without load', () => {
    const backend = makeBackend({ status: 'idle' });
    delete backend.load;
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Not loaded');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders download progress while loading', () => {
    const backend = makeBackend({ status: 'loading' });
    backend.setProgress({
      state: 'downloading',
      bytesLoaded: 250_000,
      bytesTotal: 500_000,
      percent: 50,
    });
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByText('Downloading model')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('offers a retry after a failed load', async () => {
    const backend = makeBackend({ status: 'error' });
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Load failed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(backend.loadCalls).toBe(1);
  });

  it('surfaces a rejected load inline and to the host', async () => {
    const backend = makeBackend({ status: 'idle' });
    backend.loadImpl = async () => {
      throw new Error('out of memory');
    };
    const onerror = vi.fn();
    render(ModelStatusControl, { props: { backend, onerror } });

    await userEvent.click(screen.getByRole('button', { name: 'Load model' }));
    await tick();

    expect(await screen.findByRole('alert')).toHaveTextContent('out of memory');
    expect(onerror).toHaveBeenCalledWith(expect.any(Error));
  });

  it('follows a backend status change without a host re-render', async () => {
    const backend = makeBackend({ status: 'idle' });
    render(ModelStatusControl, { props: { backend } });

    expect(screen.getByRole('status')).toHaveTextContent('Not loaded');
    backend.setStatus('ready');
    await tick();

    expect(screen.getByRole('status')).toHaveTextContent('Ready');
  });

  it('has no accessibility violations in any state', async () => {
    for (const status of [
      'unavailable',
      'idle',
      'loading',
      'ready',
      'error',
    ] as const) {
      const backend = makeBackend({ status });
      const { container, unmount } = render(ModelStatusControl, {
        props: { backend },
      });
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});
