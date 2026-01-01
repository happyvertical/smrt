/**
 * Tests for app state types and initial state
 */

import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  type SocketConfig,
  type SocketState,
  type UserSession,
} from '../state/app-state.js';

describe('createInitialState', () => {
  it('creates initial state with correct defaults', () => {
    const state = createInitialState();

    expect(state.mode).toBe('dumb');
    expect(state.modeSource).toBe('auto');
    expect(state.initialized).toBe(false);
    expect(state.error).toBeNull();
  });

  it('creates initial session with null user', () => {
    const state = createInitialState();

    expect(state.session.user).toBeNull();
    expect(state.session.isAuthenticated).toBe(false);
    expect(state.session.permissions).toEqual([]);
    expect(state.session.preferences).toEqual({});
  });

  it('creates initial socket state as disconnected', () => {
    const state = createInitialState();

    expect(state.socket.status).toBe('disconnected');
    expect(state.socket.reconnectAttempts).toBe(0);
    expect(state.socket.lastError).toBeNull();
  });

  it('creates initial AI state as uninitialized', () => {
    const state = createInitialState();

    expect(state.ai.stt.initState).toBe('uninitialized');
    expect(state.ai.tts.initState).toBe('uninitialized');
    expect(state.ai.llm.initState).toBe('uninitialized');
  });
});

describe('UserSession type', () => {
  it('allows null user', () => {
    const session: UserSession = {
      user: null,
      isAuthenticated: false,
      permissions: [],
      preferences: {},
    };

    expect(session.user).toBeNull();
    expect(session.isAuthenticated).toBe(false);
  });

  it('allows user with permissions', () => {
    const session: UserSession = {
      user: {
        id: 'user-123',
        profileId: 'profile-456',
        email: 'test@example.com',
        status: 'active',
        lastLoginAt: null,
      } as any,
      isAuthenticated: true,
      permissions: ['articles.create', 'articles.read'],
      preferences: {
        preferredSTT: 'whisper-cpp',
        autoEnableSmrt: true,
      },
    };

    expect(session.user?.email).toBe('test@example.com');
    expect(session.isAuthenticated).toBe(true);
    expect(session.permissions).toContain('articles.create');
  });
});

describe('SocketState type', () => {
  it('allows all socket statuses', () => {
    const statuses: SocketState['status'][] = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
    ];

    statuses.forEach((status) => {
      const state: SocketState = {
        status,
        reconnectAttempts: 0,
        lastError: null,
      };
      expect(state.status).toBe(status);
    });
  });
});

describe('SocketConfig type', () => {
  it('allows minimal config with just url', () => {
    const config: SocketConfig = {
      url: 'wss://example.com/ws',
    };

    expect(config.url).toBe('wss://example.com/ws');
    expect(config.reconnect).toBeUndefined();
    expect(config.onMessage).toBeUndefined();
  });

  it('allows full config with all options', () => {
    const config: SocketConfig = {
      url: 'wss://example.com/ws',
      reconnect: {
        enabled: true,
        maxAttempts: 10,
        baseDelay: 2000,
      },
      onOpen: () => {},
      onMessage: (data) => console.log(data),
      onClose: (event) => console.log(event),
      onError: (event) => console.log(event),
    };

    expect(config.url).toBe('wss://example.com/ws');
    expect(config.reconnect?.enabled).toBe(true);
    expect(config.reconnect?.maxAttempts).toBe(10);
  });
});

describe('AIConfig type', () => {
  it('creates initial AI loading state', () => {
    const state = createInitialState();

    expect(state.aiLoading.phase).toBe('idle');
    expect(state.aiLoading.currentAdapter).toBeNull();
    expect(state.aiLoading.overallProgress).toBe(0);
    expect(state.aiLoading.message).toBe('');
    expect(state.aiLoading.loaded).toEqual([]);
    expect(state.aiLoading.failed).toEqual([]);
    expect(state.aiLoading.error).toBeNull();
  });
});

describe('AIConfig types', () => {
  it('allows preload strategies', () => {
    const strategies = ['none', 'eager', 'idle', 'on-visible'] as const;
    strategies.forEach((strategy) => {
      expect(strategy).toBeDefined();
    });
  });

  it('allows STT config', () => {
    const sttConfig = {
      type: 'whisper-cpp' as const,
      model: 'tiny.en',
      enabled: true,
    };
    expect(sttConfig.type).toBe('whisper-cpp');
    expect(sttConfig.model).toBe('tiny.en');
  });

  it('allows TTS config', () => {
    const ttsConfig = {
      type: 'browser-synthesis' as const,
      voice: 'Google UK English Female',
      enabled: true,
    };
    expect(ttsConfig.type).toBe('browser-synthesis');
  });

  it('allows LLM config', () => {
    const llmConfig = {
      type: 'webllm' as const,
      model: 'Llama-3.1-8B-Instruct',
      enabled: true,
    };
    expect(llmConfig.type).toBe('webllm');
    expect(llmConfig.model).toBe('Llama-3.1-8B-Instruct');
  });
});
