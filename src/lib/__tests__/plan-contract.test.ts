import { describe, expect, it } from 'vitest';
import {
  extractPlanItems,
  getPlanProgress,
  isBlackBoxUpdatePlanTool,
  normalizePlanItems,
} from '../plan-contract';

describe('persistent Plan contract', () => {
  it('normalizes Claude TodoWrite and Codex update_plan item shapes', () => {
    expect(normalizePlanItems([
      { content: 'Inspect the bug', activeForm: 'Inspecting the bug', status: 'in_progress' },
      { step: 'Fix the bug', status: 'pending' },
    ])).toEqual([
      { step: 'Inspect the bug', activeForm: 'Inspecting the bug', status: 'in_progress' },
      { step: 'Fix the bug', status: 'pending' },
    ]);
  });

  it('enforces one in-progress item and fail-closes invalid states', () => {
    expect(() => normalizePlanItems([])).toThrow(RangeError);
    expect(() => normalizePlanItems([{ step: 'x', status: 'unknown' }])).toThrow(RangeError);
    expect(() => normalizePlanItems([
      { step: 'one', status: 'in_progress' },
      { step: 'two', status: 'in_progress' },
    ])).toThrow('at most one');
  });

  it('turns an approved numbered Markdown plan into executable state', () => {
    expect(extractPlanItems('# Plan\n\n1. Inspect\n2) Implement\n- ignored')).toEqual([
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Implement', status: 'pending' },
    ]);
  });

  it('derives progress without mutating the plan', () => {
    const items = normalizePlanItems([
      { step: 'done', status: 'completed' },
      { step: 'working', status: 'in_progress' },
      { step: 'later', status: 'pending' },
    ]);
    expect(getPlanProgress(items)).toMatchObject({ completed: 1, total: 3, inProgress: { step: 'working' } });
  });

  it('recognizes only the reserved Black Box MCP update_plan tool', () => {
    expect(isBlackBoxUpdatePlanTool('mcp__blackbox-plan__update_plan')).toBe(true);
    expect(isBlackBoxUpdatePlanTool('mcp__blackbox_plan__update_plan')).toBe(true);
    expect(isBlackBoxUpdatePlanTool('mcp__other__update_plan')).toBe(false);
    expect(isBlackBoxUpdatePlanTool('mcp__other_blackbox-plan__update_plan')).toBe(false);
    expect(isBlackBoxUpdatePlanTool('TodoWrite')).toBe(false);
  });
});
