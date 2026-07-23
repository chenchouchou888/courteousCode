import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  loadGoals: vi.fn(),
  saveGoals: vi.fn(),
}));

vi.mock('../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import {
  goalElapsedMs,
  useGoalStore,
  type GoalRecord,
} from '../stores/goalStore';
import {
  captureGoalSignal,
  handleGoalTurnResult,
} from '../lib/goal-continuation';

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    threadId: 'thread-a',
    objective: 'Preserve the Goal safely',
    status: 'paused',
    tokensUsed: 0,
    turns: 0,
    continuationTurns: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    elapsedActiveMs: 0,
    ...overrides,
  };
}

describe('Goal store behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bridgeMock.loadGoals.mockReset();
    bridgeMock.saveGoals.mockReset();
    bridgeMock.saveGoals.mockResolvedValue(undefined);
    useGoalStore.setState({ goals: {}, loaded: false });
  });

  it('keeps in-memory authority and never writes an empty replacement when loading fails', async () => {
    const existing = goal();
    useGoalStore.setState({ goals: { [existing.threadId]: existing }, loaded: false });
    bridgeMock.loadGoals.mockRejectedValueOnce(new Error('temporary read failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useGoalStore.getState().loadGoals();

    expect(useGoalStore.getState().goals).toEqual({ [existing.threadId]: existing });
    expect(useGoalStore.getState().loaded).toBe(true);
    expect(bridgeMock.saveGoals).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[BLACKBOX Goal] Failed to load goals:',
      expect.any(Error),
    );
  });

  it('single-flights startup loading and refuses to overwrite a newer local mutation', async () => {
    let resolveLoad!: (value: Record<string, GoalRecord>) => void;
    bridgeMock.loadGoals.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));

    const firstLoad = useGoalStore.getState().loadGoals();
    const secondLoad = useGoalStore.getState().loadGoals();
    expect(bridgeMock.loadGoals).toHaveBeenCalledTimes(1);

    const local = useGoalStore.getState().createGoal('thread-new', 'New local Goal');
    resolveLoad({ 'thread-old': goal({ threadId: 'thread-old' }) });
    await Promise.all([firstLoad, secondLoad]);

    expect(useGoalStore.getState().goals['thread-new']).toMatchObject(local);
    expect(useGoalStore.getState().goals['thread-old']).toBeUndefined();
    expect(useGoalStore.getState().loaded).toBe(true);
  });

  it('closes active time while waiting, restarts it on resume, and rejects duplicate turn starts', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    useGoalStore.getState().createGoal('thread-a', 'Timed Goal');

    now.mockReturnValue(1_600);
    useGoalStore.getState().markWaiting('thread-a', 'no_tool_call');
    const waiting = useGoalStore.getState().goals['thread-a'];
    expect(waiting.activeSince).toBeUndefined();
    expect(waiting.elapsedActiveMs).toBe(600);
    expect(goalElapsedMs(waiting, 8_000)).toBe(600);

    now.mockReturnValue(8_000);
    useGoalStore.getState().resumeGoal('thread-a');
    const resumed = useGoalStore.getState().goals['thread-a'];
    expect(resumed.waitReason).toBeUndefined();
    expect(resumed.activeSince).toBe(8_000);
    expect(goalElapsedMs(resumed, 8_250)).toBe(850);

    const firstTurn = useGoalStore.getState().markTurnStarted('thread-a', 'user');
    const duplicate = useGoalStore.getState().markTurnStarted('thread-a', 'continuation');
    expect(firstTurn?.currentTurnId).toBeTruthy();
    expect(duplicate).toBeUndefined();
    expect(useGoalStore.getState().goals['thread-a'].continuationTurns).toBe(0);
  });

  it('does not let a captured signal from a paused turn complete a later turn', () => {
    useGoalStore.getState().createGoal('thread-a', 'Signal isolation Goal');
    useGoalStore.getState().markTurnStarted('thread-a', 'user');
    captureGoalSignal(
      'thread-a',
      '<blackbox-goal-status>{"status":"complete","evidence":"stale"}</blackbox-goal-status>',
    );
    useGoalStore.getState().pauseGoal('thread-a', 'interrupted');
    useGoalStore.getState().resumeGoal('thread-a');
    useGoalStore.getState().markTurnStarted('thread-a', 'user');

    handleGoalTurnResult({
      tabId: 'thread-a',
      resultId: 'new-result',
      success: true,
      resultText: 'No control signal in this turn.',
      inputTokens: 10,
      outputTokens: 5,
      sessionMode: 'plan',
    });

    expect(useGoalStore.getState().goals['thread-a']).toMatchObject({
      status: 'active',
      waitReason: 'plan_only',
      turns: 1,
      completionEvidence: undefined,
    });
  });
});
