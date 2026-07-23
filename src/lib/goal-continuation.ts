import { bridge } from './tauri-bridge';
import { buildGoalContinuationPrompt, parseGoalSignal } from './goal-contract';
import { generateMessageId, isSessionBusy, useChatStore } from '../stores/chatStore';
import { useGoalStore } from '../stores/goalStore';
import { useSessionStore } from '../stores/sessionStore';
import { resetCachedTurn, useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';

interface GoalTurnResult {
  tabId: string;
  resultId: string;
  success: boolean;
  resultText?: string;
  inputTokens: number;
  outputTokens: number;
  sessionMode: string;
}

const pendingContinuations = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSignals = new Map<string, {
  turnId: string;
  signal: NonNullable<ReturnType<typeof parseGoalSignal>>;
}>();

export function captureGoalSignal(tabId: string, value: unknown): void {
  const signal = parseGoalSignal(value);
  const turnId = useGoalStore.getState().goals[tabId]?.currentTurnId;
  if (signal && turnId) pendingSignals.set(tabId, { turnId, signal });
}

function currentTurnUsedTools(tabId: string, startedAt: number | undefined): boolean {
  if (!startedAt) return false;
  return (useChatStore.getState().getTab(tabId)?.messages ?? []).some(
    (message) => message.type === 'tool_use' && message.timestamp >= startedAt,
  );
}

function visibleGoalEvent(tabId: string, content: string, state: string): void {
  useChatStore.getState().addMessage(tabId, {
    id: generateMessageId(),
    role: 'system',
    type: 'text',
    content,
    commandType: 'action',
    commandData: { action: 'goal', state },
    timestamp: Date.now(),
  });
}

async function sendContinuation(tabId: string): Promise<boolean> {
  const goal = useGoalStore.getState().goals[tabId];
  const tab = useChatStore.getState().getTab(tabId);
  if (!goal || goal.status !== 'active' || !tab) return false;
  if (isSessionBusy(tab.sessionStatus)) return false;
  if (tab.pendingUserMessages.length > 0) return false;
  if (tab.messages.some((message) => (
    ['question', 'permission', 'plan_review'].includes(message.type) && !message.resolved
  ))) {
    useGoalStore.getState().markWaiting(tabId, 'awaiting_user');
    return false;
  }

  const stdinId = tab.sessionMeta.stdinId;
  if (!stdinId || tab.sessionMeta.stdinReady !== true) {
    useGoalStore.getState().markWaiting(tabId, 'needs_resume');
    if (useSessionStore.getState().selectedSessionId === tabId) {
      window.dispatchEvent(new CustomEvent('blackbox:goal-submit', {
        detail: { tabId, prompt: buildGoalContinuationPrompt(goal.objective) },
      }));
      return true;
    }
    return false;
  }

  const turn = useGoalStore.getState().markTurnStarted(tabId, 'continuation');
  if (!turn) return false;
  const prompt = buildGoalContinuationPrompt(goal.objective);
  const startedAt = Date.now();
  useChatStore.getState().setSessionStatus(tabId, 'running');
  useChatStore.getState().setSessionMeta(tabId, {
    turnStartTime: startedAt,
    lastProgressAt: startedAt,
    inputTokens: 0,
    outputTokens: 0,
    teardownReason: undefined,
    pendingTurnMessageId: undefined,
    pendingTurnInput: undefined,
    pendingTurnAttachments: undefined,
  });
  useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
  const preserveTeammates = tab.sessionMeta.configSnapshot?.agentTeamsEnabled
    ?? useSettingsStore.getState().agentTeamsEnabled;
  if (useSessionStore.getState().selectedSessionId === tabId) {
    useAgentStore.getState().resetForTurn(goal.objective.slice(0, 100), preserveTeammates);
  } else {
    resetCachedTurn(tabId, goal.objective.slice(0, 100), preserveTeammates);
  }
  visibleGoalEvent(tabId, `Goal · continuing (${turn.continuationTurns})`, 'continuing');

  try {
    await bridge.sendStdin(stdinId, prompt);
    return true;
  } catch (error) {
    useChatStore.getState().setSessionStatus(tabId, 'error');
    useGoalStore.getState().pauseGoal(tabId, 'turn_failed', String(error));
    visibleGoalEvent(tabId, 'Goal continuation failed and was paused.', 'error');
    return false;
  }
}

function scheduleContinuation(tabId: string, delayMs = 150): void {
  const existing = pendingContinuations.get(tabId);
  if (existing) clearTimeout(existing);
  const deadline = Date.now() + 30_000;

  const attempt = async () => {
    pendingContinuations.delete(tabId);
    const goal = useGoalStore.getState().goals[tabId];
    if (!goal || goal.status !== 'active' || goal.currentTurnId) return;
    const tab = useChatStore.getState().getTab(tabId);
    if (!tab) return;
    if (isSessionBusy(tab.sessionStatus) || tab.sessionMeta.pendingCommandMsgId) {
      if (Date.now() < deadline) {
        pendingContinuations.set(tabId, setTimeout(attempt, 500));
      } else {
        useGoalStore.getState().markWaiting(tabId, 'needs_resume');
      }
      return;
    }
    await sendContinuation(tabId);
  };

  pendingContinuations.set(tabId, setTimeout(attempt, delayMs));
}

export function handleGoalTurnResult(result: GoalTurnResult): void {
  const before = useGoalStore.getState().goals[result.tabId];
  const captured = pendingSignals.get(result.tabId);
  pendingSignals.delete(result.tabId);
  if (!before || before.status !== 'active' || !before.currentTurnId) return;
  const turnId = before.currentTurnId;
  const usedTools = currentTurnUsedTools(result.tabId, before.currentTurnStartedAt);
  const recorded = useGoalStore.getState().recordTurn({
    threadId: result.tabId,
    resultId: result.resultId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    usedTools,
  });
  if (!recorded) return;

  const signal = parseGoalSignal(result.resultText)
    ?? (captured?.turnId === turnId ? captured.signal : null);
  if (signal?.status === 'complete') {
    useGoalStore.getState().completeGoal(result.tabId, signal.evidence);
    visibleGoalEvent(result.tabId, 'Goal completed with evidence.', 'completed');
    return;
  }
  if (signal?.status === 'blocked') {
    useGoalStore.getState().blockGoal(result.tabId, signal.evidence);
    visibleGoalEvent(result.tabId, 'Goal is blocked and needs input.', 'blocked');
    return;
  }
  if (!result.success) {
    useGoalStore.getState().pauseGoal(result.tabId, 'turn_failed', result.resultText);
    visibleGoalEvent(result.tabId, 'Goal paused after a failed turn.', 'error');
    return;
  }
  if (recorded.tokenBudget && recorded.tokensUsed >= recorded.tokenBudget) {
    useGoalStore.getState().limitGoal(result.tabId);
    visibleGoalEvent(result.tabId, 'Goal stopped at its token budget; this is not completion.', 'budget_limited');
    return;
  }
  if (result.sessionMode === 'plan') {
    useGoalStore.getState().markWaiting(result.tabId, 'plan_only');
    return;
  }
  if (recorded.lastTurnOrigin === 'continuation' && !recorded.lastTurnUsedTools) {
    useGoalStore.getState().markWaiting(result.tabId, 'no_tool_call');
    visibleGoalEvent(result.tabId, 'Goal auto-continuation stopped because the last continuation used no tools.', 'waiting');
    return;
  }

  scheduleContinuation(result.tabId);
}

export function resumeGoalExecution(tabId: string): void {
  const goal = useGoalStore.getState().goals[tabId];
  if (!goal) return;
  if (goal.status === 'paused' || goal.status === 'blocked' || (goal.status === 'active' && goal.waitReason)) {
    useGoalStore.getState().resumeGoal(tabId);
  }
  scheduleContinuation(tabId, 0);
}

export function pauseGoalForUserStop(tabId: string): void {
  useGoalStore.getState().pauseGoal(tabId, 'interrupted');
}

export function pauseGoalForProcessExit(tabId: string): boolean {
  const goal = useGoalStore.getState().goals[tabId];
  if (!goal || goal.status !== 'active' || !goal.currentTurnId) return false;
  useGoalStore.getState().pauseGoal(
    tabId,
    'interrupted',
    'The active Goal turn ended before a result was received.',
  );
  visibleGoalEvent(tabId, 'Goal paused because the active turn ended before a result.', 'paused');
  return true;
}
