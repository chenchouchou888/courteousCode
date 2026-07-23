import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  loadGoals: vi.fn(async () => ({})),
  saveGoals: vi.fn(async () => undefined),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import { goalElapsedMs, useGoalStore } from '../goalStore';

describe('goalStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
    bridgeMock.loadGoals.mockReset().mockResolvedValue({});
    bridgeMock.saveGoals.mockReset().mockResolvedValue(undefined);
    useGoalStore.setState({ goals: {}, loaded: false });
  });

  afterEach(() => vi.useRealTimers());

  it('tracks active time across pause and resume without treating pause as completion', () => {
    const goal = useGoalStore.getState().createGoal('thread-1', 'Pass the evidence gate', 10_000);
    vi.advanceTimersByTime(2_000);
    expect(goalElapsedMs(useGoalStore.getState().goals['thread-1'])).toBe(2_000);

    useGoalStore.getState().pauseGoal('thread-1', 'interrupted');
    const paused = useGoalStore.getState().goals['thread-1'];
    expect(paused.status).toBe('paused');
    expect(paused.elapsedActiveMs).toBe(2_000);

    vi.advanceTimersByTime(5_000);
    expect(goalElapsedMs(useGoalStore.getState().goals['thread-1'])).toBe(2_000);
    useGoalStore.getState().resumeGoal('thread-1');
    expect(useGoalStore.getState().goals['thread-1'].status).toBe('active');
    expect(goal.tokenBudget).toBe(10_000);
  });

  it('accounts only a started Goal turn and de-duplicates result frames', () => {
    useGoalStore.getState().createGoal('thread-1', 'Verify output');
    useGoalStore.getState().markTurnStarted('thread-1', 'continuation');
    const first = useGoalStore.getState().recordTurn({
      threadId: 'thread-1', resultId: 'result-1', inputTokens: 120, outputTokens: 30, usedTools: true,
    });
    expect(first?.tokensUsed).toBe(150);
    expect(first?.turns).toBe(1);
    expect(first?.continuationTurns).toBe(1);
    expect(useGoalStore.getState().recordTurn({
      threadId: 'thread-1', resultId: 'result-1', inputTokens: 120, outputTokens: 30, usedTools: true,
    })).toBeUndefined();
  });

  it('migrates a draft Goal to the real CLI thread id', () => {
    useGoalStore.getState().createGoal('draft-1', 'Keep the objective');
    useGoalStore.getState().moveGoal('draft-1', 'real-1');
    expect(useGoalStore.getState().goals['draft-1']).toBeUndefined();
    expect(useGoalStore.getState().goals['real-1']?.threadId).toBe('real-1');
    expect(useGoalStore.getState().goals['real-1']?.objective).toBe('Keep the objective');
  });

  it('enforces the official 4,000-character thread Goal limit', () => {
    expect(() => useGoalStore.getState().createGoal('thread-1', '')).toThrow(RangeError);
    expect(() => useGoalStore.getState().createGoal('thread-1', 'x'.repeat(4_001))).toThrow(RangeError);
    expect(useGoalStore.getState().createGoal('thread-1', 'x'.repeat(4_000)).objective).toHaveLength(4_000);
  });

  it('loads an interrupted active Goal as paused', async () => {
    bridgeMock.loadGoals.mockResolvedValue({
      thread: {
        threadId: 'thread', objective: 'Do not surprise-run on launch', status: 'active',
        tokensUsed: 0, turns: 0, continuationTurns: 0,
        createdAt: Date.now() - 10_000, updatedAt: Date.now() - 5_000,
        activeSince: Date.now() - 5_000, elapsedActiveMs: 1_000,
      },
    });
    await useGoalStore.getState().loadGoals();
    const loaded = useGoalStore.getState().goals.thread;
    expect(loaded.status).toBe('paused');
    expect(loaded.waitReason).toBe('interrupted');
    expect(loaded.elapsedActiveMs).toBe(6_000);
  });
});
