import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './__tests__/provider-mode-harness.svelte';
import type { STTAdapter } from './browser-ai/core/types.js';
import {
  createAppState,
  SmrtAppStateManager,
} from './state/app-state.svelte.js';

let initializationModes: string[];
let manager: SmrtAppStateManager;
const capture = (state: SmrtAppStateManager) => {
  manager = state;
};

beforeEach(() => {
  initializationModes = [];
  vi.stubGlobal('SpeechRecognition', class {});
  const initialize = SmrtAppStateManager.prototype.initialize;
  vi.spyOn(SmrtAppStateManager.prototype, 'initialize').mockImplementation(
    function () {
      const result = initialize.call(this);
      // Inspect the real initialization boundary before a later reactive effect
      // can hide a transient auto-enabled mode.
      initializationModes.push(this.state.mode);
      return result;
    },
  );
  vi.spyOn(SmrtAppStateManager.prototype, 'initializeSTT').mockResolvedValue(
    {} as STTAdapter,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Provider voice opt-in', () => {
  it('keeps defaults in standard mode even with speech capabilities', async () => {
    render(Harness, { props: { capture } });
    await waitFor(() => expect(manager.state.initialized).toBe(true));
    expect(manager.state.capabilities?.stt.browserSpeechAPI).toBe(true);
    expect(manager.state.mode).toBe('default');
    expect(initializationModes).toEqual(['default']);
    expect(manager.initializeSTT).not.toHaveBeenCalled();
  });

  it('honors explicit default before initialization despite auto-detection opt-in', async () => {
    render(Harness, {
      props: { capture, mode: 'default', autoEnableSmrt: true },
    });
    await waitFor(() => expect(manager.state.initialized).toBe(true));
    expect(initializationModes).toEqual(['default']);
    expect(manager.state.modeSource).toBe('explicit');
    expect(manager.initializeSTT).not.toHaveBeenCalled();
  });

  it('preserves explicit smrt mode and reactive mode updates', async () => {
    const view = render(Harness, { props: { capture, mode: 'smrt' } });
    await waitFor(() => expect(manager.state.initialized).toBe(true));
    expect(initializationModes).toEqual(['smrt']);
    expect(manager.state.modeSource).toBe('explicit');
    await view.rerender({ capture, mode: 'default' });
    expect(screen.getByRole('status', { name: 'App mode' })).toHaveTextContent(
      'default',
    );
  });

  it('retains auto-detection behind the explicit flag', async () => {
    render(Harness, { props: { capture, autoEnableSmrt: true } });
    await waitFor(() => expect(manager.state.initialized).toBe(true));
    expect(manager.state.mode).toBe('smrt');
    expect(manager.state.modeSource).toBe('auto');
  });

  it('does not auto-enable when capabilities are unavailable', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    const capability = await import('./browser-ai/capabilities/detector.js');
    vi.spyOn(capability, 'canEnableSmrtMode').mockReturnValue(false);
    render(Harness, { props: { capture, autoEnableSmrt: true } });
    await waitFor(() => expect(manager.state.initialized).toBe(true));
    expect(manager.state.mode).toBe('default');
  });

  it('standalone state also requires explicit opt-in and respects initial session preferences', async () => {
    const standard = createAppState();
    await standard.initialize();
    expect(standard.state.mode).toBe('default');
    const auto = createAppState({
      session: { preferences: { autoEnableSmrt: true } },
    });
    await auto.initialize();
    expect(auto.state.mode).toBe('smrt');
    const explicit = createAppState({
      initialMode: 'default',
      session: { preferences: { autoEnableSmrt: true } },
    });
    await explicit.initialize();
    expect(explicit.state.mode).toBe('default');
    expect(explicit.state.modeSource).toBe('explicit');
    await Promise.all([standard.dispose(), auto.dispose(), explicit.dispose()]);
  });
});
