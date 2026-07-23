export const GOAL_INTERNAL_TAG = 'blackbox-goal-internal';
export const GOAL_STATUS_TAG = 'blackbox-goal-status';

export type GoalSignalStatus = 'continue' | 'complete' | 'blocked';

export interface GoalSignal {
  status: GoalSignalStatus;
  evidence?: string;
}

export type ParsedGoalCommand =
  | { kind: 'view' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'create'; objective: string; tokenBudget?: number }
  | { kind: 'error'; message: string };

export const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;
const MAX_GOAL_TITLE_LENGTH = 80;

export function buildGoalSessionTitle(objective: string): string {
  const normalized = objective.replace(/\s+/g, ' ').trim();
  const visible = normalized.length > MAX_GOAL_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_GOAL_TITLE_LENGTH - 1).trimEnd()}…`
    : normalized;
  return visible ? `Goal · ${visible}` : 'Goal';
}

export function parseGoalCommand(raw: string | undefined): ParsedGoalCommand {
  const args = (raw || '').trim();
  if (!args) return { kind: 'view' };

  const normalized = args.toLowerCase();
  if (normalized === 'pause') return { kind: 'pause' };
  if (normalized === 'resume') return { kind: 'resume' };
  if (normalized === 'clear') return { kind: 'clear' };

  let objective = args;
  let tokenBudget: number | undefined;
  const budgetMatch = objective.match(/^--budget(?:=|\s+)(\d+)\s+([\s\S]+)$/i);
  if (budgetMatch) {
    tokenBudget = Number(budgetMatch[1]);
    objective = budgetMatch[2].trim();
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1_000 || tokenBudget > 100_000_000) {
      return { kind: 'error', message: 'Goal token budget must be between 1,000 and 100,000,000.' };
    }
  } else if (/^--budget(?:=|\s|$)/i.test(objective)) {
    return { kind: 'error', message: 'Usage: /codex-goal --budget 50000 <objective>' };
  }

  if (!objective) return { kind: 'error', message: 'Goal objective cannot be empty.' };
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return { kind: 'error', message: `Goal objective must be at most ${MAX_GOAL_OBJECTIVE_LENGTH.toLocaleString()} characters.` };
  }
  return { kind: 'create', objective, tokenBudget };
}

function goalProtocol(objective: string): string {
  return [
    `Goal objective: ${objective}`,
    '',
    'Treat this as a persistent, thread-scoped completion contract.',
    'Work against concrete evidence in this thread. Do not declare completion from confidence alone.',
    'If the objective is not yet satisfied and a useful in-scope action remains, take that action in this turn.',
    'If user input or new authority is genuinely required, stop and report the exact blocker.',
    'At the absolute end of every Goal turn, emit exactly one machine-readable status tag:',
    '<blackbox-goal-status>{"status":"continue","evidence":"what remains"}</blackbox-goal-status>',
    'or',
    '<blackbox-goal-status>{"status":"complete","evidence":"specific verification"}</blackbox-goal-status>',
    'or',
    '<blackbox-goal-status>{"status":"blocked","evidence":"blocker and unlock condition"}</blackbox-goal-status>',
    'The tag is control metadata and must not be discussed in the visible answer.',
  ].join('\n');
}

export function buildGoalStartPrompt(objective: string): string {
  return [
    `<${GOAL_INTERNAL_TAG} version="1" kind="start">`,
    goalProtocol(objective),
    '',
    'Begin now. First inspect the available evidence, then take the next useful action.',
    `</${GOAL_INTERNAL_TAG}>`,
  ].join('\n');
}

export function buildGoalContinuationPrompt(objective: string): string {
  return [
    `<${GOAL_INTERNAL_TAG} version="1" kind="continuation">`,
    goalProtocol(objective),
    '',
    'Audit the objective against the newest evidence from the previous turn.',
    'If it is not complete, choose and execute the next highest-value in-scope action.',
    `</${GOAL_INTERNAL_TAG}>`,
  ].join('\n');
}

export function parseGoalSignal(value: unknown): GoalSignal | null {
  if (typeof value !== 'string' || !value) return null;
  const matches = Array.from(value.matchAll(
    /<blackbox-goal-status>\s*([\s\S]*?)\s*<\/blackbox-goal-status>/gi,
  ));
  const raw = matches.length > 0 ? matches[matches.length - 1]?.[1] : undefined;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!['continue', 'complete', 'blocked'].includes(String(parsed.status))) return null;
    return {
      status: parsed.status as GoalSignalStatus,
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence.trim().slice(0, 4_000) : undefined,
    };
  } catch {
    return null;
  }
}

export function stripGoalControlMetadata(value: string): string {
  return value
    .replace(/\n?<blackbox-goal-status>[\s\S]*?<\/blackbox-goal-status>\s*/gi, '')
    .replace(/\n?<blackbox-goal-internal\b[^>]*>[\s\S]*?<\/blackbox-goal-internal>\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}
