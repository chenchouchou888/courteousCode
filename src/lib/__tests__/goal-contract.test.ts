import { describe, expect, it } from 'vitest';
import {
  buildGoalSessionTitle,
  buildGoalContinuationPrompt,
  buildGoalStartPrompt,
  parseGoalCommand,
  parseGoalSignal,
  stripGoalControlMetadata,
} from '../goal-contract';

describe('Goal contract', () => {
  it('builds a bounded user-facing title instead of exposing the internal contract', () => {
    const title = buildGoalSessionTitle('  Verify   two rounds\nwith evidence  ');
    expect(title).toBe('Goal · Verify two rounds with evidence');
    expect(buildGoalSessionTitle('x'.repeat(200)).length).toBeLessThanOrEqual(87);
    expect(title).not.toContain('blackbox-goal-internal');
  });

  it('matches the official 4,000-character Goal objective limit', () => {
    expect(parseGoalCommand('x'.repeat(4_000))).toMatchObject({ kind: 'create' });
    expect(parseGoalCommand('x'.repeat(4_001))).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('4,000'),
    });
  });

  it('parses lifecycle commands and an optional token budget', () => {
    expect(parseGoalCommand(undefined)).toEqual({ kind: 'view' });
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' });
    expect(parseGoalCommand('--budget 50000 Make the suite green')).toEqual({
      kind: 'create', objective: 'Make the suite green', tokenBudget: 50_000,
    });
  });

  it('rejects unsafe or empty budgets', () => {
    expect(parseGoalCommand('--budget 10 Too small').kind).toBe('error');
    expect(parseGoalCommand('--budget 50000').kind).toBe('error');
  });

  it('builds hidden start and continuation prompts with the evidence contract', () => {
    const start = buildGoalStartPrompt('Reach a verified outcome');
    const continuation = buildGoalContinuationPrompt('Reach a verified outcome');
    expect(start).toContain('<blackbox-goal-internal');
    expect(start).toContain('specific verification');
    expect(continuation).toContain('Audit the objective');
    expect(continuation).toContain('Reach a verified outcome');
  });

  it('reads the final valid signal and strips all control metadata from display', () => {
    const raw = `Visible answer.
<blackbox-goal-status>{"status":"continue","evidence":"first"}</blackbox-goal-status>
More evidence.
<blackbox-goal-status>{"status":"complete","evidence":"tests passed"}</blackbox-goal-status>`;
    expect(parseGoalSignal(raw)).toEqual({ status: 'complete', evidence: 'tests passed' });
    const visible = stripGoalControlMetadata(raw);
    expect(visible).toContain('Visible answer.');
    expect(visible).not.toContain('blackbox-goal-status');
    expect(visible).not.toContain('tests passed');
  });
});
