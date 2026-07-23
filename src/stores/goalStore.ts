import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';
import { MAX_GOAL_OBJECTIVE_LENGTH } from '../lib/goal-contract';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked' | 'budget_limited';
export type GoalTurnOrigin = 'user' | 'continuation';
export type GoalWaitReason =
  | 'interrupted'
  | 'plan_only'
  | 'no_tool_call'
  | 'needs_resume'
  | 'awaiting_user'
  | 'turn_failed';

export interface GoalRecord {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  turns: number;
  continuationTurns: number;
  createdAt: number;
  updatedAt: number;
  activeSince?: number;
  elapsedActiveMs: number;
  waitReason?: GoalWaitReason;
  completionEvidence?: string;
  lastError?: string;
  currentTurnId?: string;
  currentTurnOrigin?: GoalTurnOrigin;
  currentTurnStartedAt?: number;
  lastTurnOrigin?: GoalTurnOrigin;
  lastTurnUsedTools?: boolean;
  lastProcessedResultId?: string;
}

interface GoalState {
  goals: Record<string, GoalRecord>;
  loaded: boolean;
  loadGoals: () => Promise<void>;
  createGoal: (threadId: string, objective: string, tokenBudget?: number) => GoalRecord;
  pauseGoal: (threadId: string, reason?: GoalWaitReason, error?: string) => void;
  resumeGoal: (threadId: string) => void;
  clearGoal: (threadId: string) => void;
  completeGoal: (threadId: string, evidence?: string) => void;
  blockGoal: (threadId: string, evidence?: string) => void;
  limitGoal: (threadId: string) => void;
  markWaiting: (threadId: string, reason: GoalWaitReason) => void;
  markTurnStarted: (threadId: string, origin: GoalTurnOrigin) => GoalRecord | undefined;
  recordTurn: (args: {
    threadId: string;
    resultId: string;
    inputTokens: number;
    outputTokens: number;
    usedTools: boolean;
  }) => GoalRecord | undefined;
  moveGoal: (oldThreadId: string, newThreadId: string) => void;
}

const MAX_GOAL_RECORDS = 200;
let writeQueue: Promise<void> = Promise.resolve();
let loadPromise: Promise<void> | null = null;
let mutationRevision = 0;

function persist(goals: Record<string, GoalRecord>): void {
  const snapshot = JSON.parse(JSON.stringify(goals)) as Record<string, GoalRecord>;
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => bridge.saveGoals(snapshot))
    .catch((error) => console.warn('[BLACKBOX Goal] Failed to persist goals:', error));
}

function closeActiveClock(goal: GoalRecord, now = Date.now()): GoalRecord {
  if (!goal.activeSince) return { ...goal, updatedAt: now };
  return {
    ...goal,
    activeSince: undefined,
    elapsedActiveMs: goal.elapsedActiveMs + Math.max(0, now - goal.activeSince),
    updatedAt: now,
  };
}

function isGoalRecord(value: unknown): value is GoalRecord {
  if (!value || typeof value !== 'object') return false;
  const goal = value as Partial<GoalRecord>;
  return typeof goal.threadId === 'string'
    && typeof goal.objective === 'string'
    && goal.objective.length > 0
    && goal.objective.length <= MAX_GOAL_OBJECTIVE_LENGTH
    && ['active', 'paused', 'completed', 'blocked', 'budget_limited'].includes(String(goal.status))
    && Number.isFinite(goal.createdAt)
    && Number.isFinite(goal.updatedAt);
}

function sanitizeLoadedGoals(value: unknown): Record<string, GoalRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const now = Date.now();
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, record]) => isGoalRecord(record))
    .sort(([, a], [, b]) => (b as GoalRecord).updatedAt - (a as GoalRecord).updatedAt)
    .slice(0, MAX_GOAL_RECORDS);
  const goals: Record<string, GoalRecord> = {};
  for (const [key, raw] of entries) {
    const record = raw as GoalRecord;
    // An app/process exit is an interruption boundary. Persisted active Goals
    // resume as paused so reopening the app never starts surprise work.
    const normalized = record.status === 'active'
      ? {
        ...closeActiveClock(record, now),
        status: 'paused' as const,
        waitReason: 'interrupted' as const,
        currentTurnId: undefined,
        currentTurnOrigin: undefined,
        currentTurnStartedAt: undefined,
      }
      : record;
    goals[key] = {
      ...normalized,
      threadId: key,
      tokensUsed: Math.max(0, Number(normalized.tokensUsed) || 0),
      turns: Math.max(0, Number(normalized.turns) || 0),
      continuationTurns: Math.max(0, Number(normalized.continuationTurns) || 0),
      elapsedActiveMs: Math.max(0, Number(normalized.elapsedActiveMs) || 0),
    };
  }
  return goals;
}

export function goalElapsedMs(goal: GoalRecord, now = Date.now()): number {
  return goal.elapsedActiveMs + (goal.activeSince ? Math.max(0, now - goal.activeSince) : 0);
}

export const useGoalStore = create<GoalState>()((set, get) => {
  const commitGoals = (goals: Record<string, GoalRecord>) => {
    mutationRevision += 1;
    set({ goals });
    persist(goals);
  };

  return {
    goals: {},
    loaded: false,

    loadGoals: () => {
      if (get().loaded) return Promise.resolve();
      if (loadPromise) return loadPromise;
      const startingRevision = mutationRevision;
      loadPromise = (async () => {
        try {
          const goals = sanitizeLoadedGoals(await bridge.loadGoals());
          // React StrictMode can start the loader twice, and a slow disk read
          // can finish after the user has already created or paused a Goal.
          // Never replace newer in-memory authority with that stale snapshot.
          if (mutationRevision === startingRevision) {
            set({ goals, loaded: true });
            persist(goals);
          } else {
            set({ loaded: true });
          }
        } catch (error) {
          // A read/parse failure is not an empty Goal database. Keep memory as
          // is and, critically, do not persist `{}` over the recoverable file.
          console.warn('[BLACKBOX Goal] Failed to load goals:', error);
          set({ loaded: true });
        }
      })().finally(() => {
        loadPromise = null;
      });
      return loadPromise;
    },

    createGoal: (threadId, objective, tokenBudget) => {
      const now = Date.now();
      const normalizedObjective = objective.trim();
      if (!normalizedObjective || normalizedObjective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
        throw new RangeError(`Goal objective must contain 1-${MAX_GOAL_OBJECTIVE_LENGTH.toLocaleString()} characters.`);
      }
      if (tokenBudget !== undefined
        && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1_000 || tokenBudget > 100_000_000)) {
        throw new RangeError('Goal token budget must be between 1,000 and 100,000,000.');
      }
      const goal: GoalRecord = {
        threadId,
        objective: normalizedObjective,
        status: 'active',
        tokenBudget,
        tokensUsed: 0,
        turns: 0,
        continuationTurns: 0,
        createdAt: now,
        updatedAt: now,
        activeSince: now,
        elapsedActiveMs: 0,
      };
      const goals = { ...get().goals, [threadId]: goal };
      commitGoals(goals);
      return goal;
    },

    pauseGoal: (threadId, reason, error) => {
      const existing = get().goals[threadId];
      if (!existing || existing.status !== 'active') return;
      const next = {
        ...closeActiveClock(existing),
        status: 'paused' as const,
        waitReason: reason,
        lastError: error,
        currentTurnId: undefined,
        currentTurnOrigin: undefined,
        currentTurnStartedAt: undefined,
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
    },

    resumeGoal: (threadId) => {
      const existing = get().goals[threadId];
      const resumableWaiting = existing?.status === 'active' && Boolean(existing.waitReason);
      if (!existing || (!['paused', 'blocked'].includes(existing.status) && !resumableWaiting)) return;
      const now = Date.now();
      const next: GoalRecord = {
        ...existing,
        status: 'active',
        activeSince: now,
        updatedAt: now,
        waitReason: undefined,
        lastError: undefined,
        completionEvidence: undefined,
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
    },

    clearGoal: (threadId) => {
      if (!get().goals[threadId]) return;
      const goals = { ...get().goals };
      delete goals[threadId];
      commitGoals(goals);
    },

    completeGoal: (threadId, evidence) => {
      const existing = get().goals[threadId];
      if (!existing) return;
      const next = {
        ...closeActiveClock(existing),
        status: 'completed' as const,
        completionEvidence: evidence,
        waitReason: undefined,
        currentTurnId: undefined,
        currentTurnOrigin: undefined,
        currentTurnStartedAt: undefined,
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
    },

    blockGoal: (threadId, evidence) => {
      const existing = get().goals[threadId];
      if (!existing) return;
      const next = {
        ...closeActiveClock(existing),
        status: 'blocked' as const,
        completionEvidence: evidence,
        waitReason: 'awaiting_user' as const,
        currentTurnId: undefined,
        currentTurnOrigin: undefined,
        currentTurnStartedAt: undefined,
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
    },

    limitGoal: (threadId) => {
      const existing = get().goals[threadId];
      if (!existing) return;
      const next = {
        ...closeActiveClock(existing),
        status: 'budget_limited' as const,
        waitReason: undefined,
        currentTurnId: undefined,
        currentTurnOrigin: undefined,
        currentTurnStartedAt: undefined,
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
    },

    markWaiting: (threadId, reason) => {
      const existing = get().goals[threadId];
      if (!existing || existing.status !== 'active') return;
      const waiting = closeActiveClock(existing);
      const goals = {
        ...get().goals,
        [threadId]: { ...waiting, waitReason: reason },
      };
      commitGoals(goals);
    },

    markTurnStarted: (threadId, origin) => {
      const existing = get().goals[threadId];
      if (!existing || existing.status !== 'active' || existing.currentTurnId) return undefined;
      const now = Date.now();
      const next: GoalRecord = {
        ...existing,
        currentTurnId: `goal_turn_${now}_${Math.random().toString(36).slice(2, 8)}`,
        currentTurnOrigin: origin,
        currentTurnStartedAt: now,
        continuationTurns: existing.continuationTurns + (origin === 'continuation' ? 1 : 0),
        waitReason: undefined,
        updatedAt: now,
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
      return next;
    },

    recordTurn: ({ threadId, resultId, inputTokens, outputTokens, usedTools }) => {
      const existing = get().goals[threadId];
      if (!existing || !existing.currentTurnId || existing.lastProcessedResultId === resultId) return undefined;
      const next: GoalRecord = {
        ...existing,
        tokensUsed: existing.tokensUsed + Math.max(0, inputTokens) + Math.max(0, outputTokens),
        turns: existing.turns + 1,
        lastTurnOrigin: existing.currentTurnOrigin,
        lastTurnUsedTools: usedTools,
        lastProcessedResultId: resultId,
        currentTurnId: undefined,
        currentTurnOrigin: undefined,
        currentTurnStartedAt: undefined,
        updatedAt: Date.now(),
      };
      const goals = { ...get().goals, [threadId]: next };
      commitGoals(goals);
      return next;
    },

    moveGoal: (oldThreadId, newThreadId) => {
      const existing = get().goals[oldThreadId];
      if (!existing || oldThreadId === newThreadId) return;
      const goals = { ...get().goals };
      delete goals[oldThreadId];
      goals[newThreadId] = { ...existing, threadId: newThreadId, updatedAt: Date.now() };
      commitGoals(goals);
    },
  };
});
