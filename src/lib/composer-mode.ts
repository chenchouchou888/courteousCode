import { MAX_GOAL_OBJECTIVE_LENGTH } from './goal-contract';
import {
  buildNativeLoopCommand,
  NATIVE_LOOP_PROMPT_MAX_LENGTH,
  validateNativeLoopInterval,
} from './native-loop';
import {
  buildAutoWorkflowCommand,
  buildNativeWorkflowCommand,
  NATIVE_WORKFLOW_ARGS_MAX_LENGTH,
} from './native-workflow';

export type TaskComposerMode = 'goal' | 'workflow' | 'loop';
export type BusyDeliveryMode = 'steer' | 'queue';

export interface TaskComposerOptions {
  goalBudget: string;
  workflowName: string;
  workflowValid: boolean;
  loopInterval: string;
}

export type TaskComposerError =
  | 'empty'
  | 'goal_too_long'
  | 'goal_budget_invalid'
  | 'workflow_invalid'
  | 'workflow_input_too_long'
  | 'loop_prompt_too_long'
  | 'loop_interval_invalid'
  | 'loop_use_scheduled';

export type TaskComposerSubmission =
  | { kind: 'goal'; objective: string; tokenBudget?: number }
  | { kind: 'workflow-auto'; command: string }
  | { kind: 'workflow'; workflowName: string; command: string }
  | { kind: 'loop'; command: string };

export type TaskComposerSubmissionResult =
  | { ok: true; value: TaskComposerSubmission }
  | { ok: false; error: TaskComposerError };

/** Selecting an active task mode returns the composer to ordinary chat. */
export function toggleTaskComposerMode(
  current: TaskComposerMode | null,
  requested: TaskComposerMode,
): TaskComposerMode | null {
  return current === requested ? null : requested;
}

export function buildTaskComposerSubmission(
  mode: TaskComposerMode,
  rawInput: string,
  options: TaskComposerOptions,
): TaskComposerSubmissionResult {
  const input = rawInput.trim();
  if (!input) return { ok: false, error: 'empty' };

  if (mode === 'goal') {
    if (input.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      return { ok: false, error: 'goal_too_long' };
    }
    const budgetText = options.goalBudget.trim();
    const tokenBudget = budgetText ? Number(budgetText) : undefined;
    if (tokenBudget !== undefined && (
      !Number.isSafeInteger(tokenBudget)
      || tokenBudget < 1_000
      || tokenBudget > 100_000_000
    )) {
      return { ok: false, error: 'goal_budget_invalid' };
    }
    return {
      ok: true,
      value: {
        kind: 'goal',
        objective: input,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      },
    };
  }

  if (mode === 'workflow') {
    const workflowName = options.workflowName.trim();
    if (input.length > NATIVE_WORKFLOW_ARGS_MAX_LENGTH) {
      return { ok: false, error: 'workflow_input_too_long' };
    }
    // Auto is the default. It stays on the ordinary send path so the UI never
    // creates a native Workflow run before the active runtime actually emits a
    // Workflow/RunWorkflow tool use and its receipt.
    if (!workflowName) {
      try {
        return {
          ok: true,
          value: {
            kind: 'workflow-auto',
            command: buildAutoWorkflowCommand(input),
          },
        };
      } catch {
        return { ok: false, error: 'workflow_input_too_long' };
      }
    }
    if (!options.workflowValid) return { ok: false, error: 'workflow_invalid' };
    try {
      return {
        ok: true,
        value: {
          kind: 'workflow',
          workflowName,
          command: buildNativeWorkflowCommand(workflowName, input),
        },
      };
    } catch {
      return { ok: false, error: 'workflow_invalid' };
    }
  }

  if (input.length > NATIVE_LOOP_PROMPT_MAX_LENGTH) {
    return { ok: false, error: 'loop_prompt_too_long' };
  }
  const intervalStatus = validateNativeLoopInterval(options.loopInterval);
  if (intervalStatus === 'invalid') return { ok: false, error: 'loop_interval_invalid' };
  if (intervalStatus === 'durable') return { ok: false, error: 'loop_use_scheduled' };
  return {
    ok: true,
    value: {
      kind: 'loop',
      command: buildNativeLoopCommand(options.loopInterval, input),
    },
  };
}
