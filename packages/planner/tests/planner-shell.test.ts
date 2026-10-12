import { describe, expect, it } from 'vitest';
import {
  PLANNER_SHELL_EDGE_TOGGLES,
  PLANNER_SHELL_PANEL_DEFAULTS,
  plannerShellProps,
} from '../src/lib/index.ts';

describe('Planner shell defaults', () => {
  it('starts navigation collapsed with a native left-edge control', () => {
    const props = plannerShellProps();
    expect(props.edgeToggles).toBe(PLANNER_SHELL_EDGE_TOGGLES);
    expect(props.config).toBe(PLANNER_SHELL_PANEL_DEFAULTS);
    expect(props.edgeToggles).toEqual({ left: true });
    expect(props.config.left).toMatchObject({
      initial: 'collapsed',
    });
  });

  it('keeps the assistant dock available through its header toggle', () => {
    expect(plannerShellProps().config.right).toMatchObject({
      initial: 'collapsed',
      rail: false,
      presentation: 'overlay',
    });
  });
});
