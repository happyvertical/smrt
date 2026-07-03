import { describe, expect, it } from 'vitest';
import * as workspace from '../index.js';

describe('workspace barrel', () => {
  it('exports AdminShell', () => {
    expect(workspace.AdminShell).toBeDefined();
  });

  it('exports shell state helpers', () => {
    expect(workspace.createShellState).toBeDefined();
    expect(workspace.resolveShellConfig).toBeDefined();
  });

  it('exports settings and activity components', () => {
    expect(workspace.ShellSettingsPanel).toBeDefined();
    expect(workspace.ActivityList).toBeDefined();
  });

  it('exports tenant nav helper from the manifest implementation', () => {
    expect(workspace.tenantNavFromManifest).toBeDefined();
    expect(typeof workspace.tenantNavFromManifest).toBe('function');
  });

  it('exports pluralizeClassName helper', () => {
    expect(workspace.pluralizeClassName).toBeDefined();
    expect(typeof workspace.pluralizeClassName).toBe('function');
  });

  it('does not export first-generation shell components as first-class API', () => {
    expect('WorkspaceShell' in workspace).toBe(false);
    expect('RoleShell' in workspace).toBe(false);
    expect('ToolsDock' in workspace).toBe(false);
  });
});
