import { describe, expect, it } from 'vitest';
import {
  buildTaskComposerSubmission,
  toggleTaskComposerMode,
  type TaskComposerOptions,
} from '../composer-mode';

const base: TaskComposerOptions = {
  goalBudget: '',
  workflowName: 'release-audit',
  workflowValid: true,
  loopInterval: '5m',
};

describe('task composer modes', () => {
  it('keeps Goal, Workflow, and Loop mutually exclusive', () => {
    expect(toggleTaskComposerMode(null, 'goal')).toBe('goal');
    expect(toggleTaskComposerMode('goal', 'workflow')).toBe('workflow');
    expect(toggleTaskComposerMode('workflow', 'loop')).toBe('loop');
    expect(toggleTaskComposerMode('loop', 'loop')).toBeNull();
  });

  it('builds a Goal from the main composer and validates its budget', () => {
    expect(buildTaskComposerSubmission('goal', '  Ship verified release  ', base)).toEqual({
      ok: true,
      value: { kind: 'goal', objective: 'Ship verified release' },
    });
    expect(buildTaskComposerSubmission('goal', 'Ship', { ...base, goalBudget: '999' }))
      .toEqual({ ok: false, error: 'goal_budget_invalid' });
    expect(buildTaskComposerSubmission('goal', 'Ship', { ...base, goalBudget: '1000' }))
      .toEqual({
        ok: true,
        value: { kind: 'goal', objective: 'Ship', tokenBudget: 1000 },
      });
    expect(buildTaskComposerSubmission('goal', 'x'.repeat(4_001), base))
      .toEqual({ ok: false, error: 'goal_too_long' });
  });

  it('submits Auto Workflow without a saved script and keeps the task from the main input', () => {
    const result = buildTaskComposerSubmission('workflow', '  audit every package  ', {
      ...base,
      workflowName: '',
      workflowValid: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'workflow-auto') throw new Error('expected auto workflow');
    expect(result.value.command).toContain('audit every package');
    expect(result.value.command).toContain('visible staged plan');
    expect(result.value.command).toContain('actually exposed by the current runtime');
    expect(result.value).not.toHaveProperty('workflowName');
    expect(result.value.command).not.toContain('Call the Workflow tool exactly once');

    expect(buildTaskComposerSubmission('workflow', 'x'.repeat(12_001), {
      ...base,
      workflowName: '',
      workflowValid: false,
    })).toEqual({ ok: false, error: 'workflow_input_too_long' });
  });

  it('keeps a saved native Workflow as an optional advanced path', () => {
    const result = buildTaskComposerSubmission('workflow', 'audit every package', base);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'workflow') throw new Error('expected workflow');
    expect(result.value.workflowName).toBe('release-audit');
    expect(result.value.command).toContain('Run the saved native Claude Code workflow “release-audit”.');
    expect(result.value.command).toContain('"args":"audit every package"');

    expect(buildTaskComposerSubmission('workflow', 'audit', { ...base, workflowValid: false }))
      .toEqual({ ok: false, error: 'workflow_invalid' });
    expect(buildTaskComposerSubmission('workflow', 'x'.repeat(12_001), base))
      .toEqual({ ok: false, error: 'workflow_input_too_long' });
  });

  it('builds native Loop from the cadence and main composer prompt', () => {
    expect(buildTaskComposerSubmission('loop', 'check build', base)).toEqual({
      ok: true,
      value: { kind: 'loop', command: '/loop 5m check build' },
    });
    expect(buildTaskComposerSubmission('loop', 'check build', { ...base, loopInterval: '' }))
      .toEqual({ ok: true, value: { kind: 'loop', command: '/loop check build' } });
    expect(buildTaskComposerSubmission('loop', 'check build', { ...base, loopInterval: '30s' }))
      .toEqual({ ok: false, error: 'loop_interval_invalid' });
    expect(buildTaskComposerSubmission('loop', 'check build', { ...base, loopInterval: '60m' }))
      .toEqual({ ok: false, error: 'loop_use_scheduled' });
    expect(buildTaskComposerSubmission('loop', 'x'.repeat(4_001), base))
      .toEqual({ ok: false, error: 'loop_prompt_too_long' });
  });
});
