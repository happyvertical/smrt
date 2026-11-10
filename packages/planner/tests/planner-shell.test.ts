import { describe, expect, it } from 'vitest';
import {
  PLANNER_SHELL_EDGE_TOGGLES,
  PLANNER_SHELL_PANEL_DEFAULTS,
  plannerShellProps,
} from '../src/lib/index.ts';

describe('Planner shell defaults', () => {
  it('starts navigation expanded with its footer controls in the sidebar', () => {
    const props = plannerShellProps();
    expect(props.edgeToggles).toBe(PLANNER_SHELL_EDGE_TOGGLES);
    expect(props.config).toBe(PLANNER_SHELL_PANEL_DEFAULTS);
    expect(props.edgeToggles).toEqual({ left: true });
    expect(props.colorSchemeToggle).toEqual({ slot: 'leftSidebar.footer' });
    expect(props.accountMenu).toEqual({ slot: 'leftSidebar.footer' });
    expect(props.config.left).toMatchObject({
      initial: 'expanded',
    });
  });

  it('keeps the assistant dock available through its header toggle', () => {
    expect(plannerShellProps().config.right).toEqual({
      initial: 'collapsed',
      rail: false,
    });
    // No presentation of its own: the shell default docks the assistant
    // beside the page from xl and slides it over the page below (#4100).
    expect(plannerShellProps().config.right).not.toHaveProperty('presentation');
  });

  it('hides the separate bottom panel by default', () => {
    expect(plannerShellProps().config.bottom).toMatchObject({
      initial: 'hidden',
    });
  });
});
