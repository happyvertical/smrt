import { describe, expect, it } from 'vitest';
import {
  DesktopContractError,
  type DesktopContractErrorCode,
  desktopContractErrorMessage,
} from './errors.js';

describe('DesktopContractError', () => {
  it('carries a code and a fixed message', () => {
    const error = new DesktopContractError('not_installed');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DesktopContractError');
    expect(error.code).toBe('not_installed');
    expect(error.message).toBe(desktopContractErrorMessage('not_installed'));
    expect(error.field).toBeUndefined();
  });

  it('records a static field name without changing the message', () => {
    const plain = new DesktopContractError('invalid_field');
    const named = new DesktopContractError('invalid_field', {
      field: 'bridge.entry',
    });
    expect(named.field).toBe('bridge.entry');
    expect(named.message).toBe(plain.message);
    expect(named.message).not.toContain('bridge');
  });

  it('has a distinct, non-empty, value-free message for every code', () => {
    const codes: DesktopContractErrorCode[] = [
      'invalid_secret',
      'not_installed',
      'unsupported_contract',
      'identity_mismatch',
      'untrusted_path',
      'invalid_json',
      'duplicate_keys',
      'invalid_document',
      'invalid_field',
      'sidecar_mismatch',
      'invalid_environment',
      'unsupported_platform',
      'invalid_control_message',
      'control_message_too_large',
      'unsupported_op',
      'invalid_endpoint',
      'untrusted_endpoint',
      'control_unreachable',
      'control_timeout',
      'control_aborted',
      'control_server_failed',
    ];
    const messages = codes.map(desktopContractErrorMessage);
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/[/\\]|\d{2,}|https?:/);
    }
  });
});
