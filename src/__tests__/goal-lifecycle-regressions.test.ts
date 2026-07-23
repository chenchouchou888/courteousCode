import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const appSource = readFileSync(resolve(root, 'App.tsx'), 'utf8');
const controlSource = readFileSync(resolve(root, 'components/chat/GoalControl.tsx'), 'utf8');
const inputSource = readFileSync(resolve(root, 'components/chat/InputBar.tsx'), 'utf8');
const storeSource = readFileSync(resolve(root, 'stores/goalStore.ts'), 'utf8');
const continuationSource = readFileSync(resolve(root, 'lib/goal-continuation.ts'), 'utf8');
const bridgeSource = readFileSync(resolve(root, 'lib/tauri-bridge.ts'), 'utf8');
const cliSource = readFileSync(resolve(root, '../scripts/blackbox-cli.mjs'), 'utf8');
const smokeSource = readFileSync(resolve(root, '../scripts/goal-lifecycle-smoke.mjs'), 'utf8');
const rustSource = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const commandStoreSource = readFileSync(resolve(root, 'stores/commandStore.ts'), 'utf8');

describe('persistent Goal lifecycle regressions', () => {
  it('turns persisted active Goals into explicitly paused work on process startup', () => {
    expect(storeSource).toContain("record.status === 'active'");
    expect(storeSource).toContain("status: 'paused' as const");
    expect(storeSource).toContain("waitReason: 'interrupted' as const");
    expect(appSource).toContain('useGoalStore.getState().loadGoals()');
    expect(storeSource).toContain('let loadPromise: Promise<void> | null = null');
    expect(storeSource).toContain('mutationRevision === startingRevision');
    expect(bridgeSource).toContain("invoke<Record<string, unknown>>('load_goals'),");
    expect(bridgeSource).not.toContain("invoke<Record<string, unknown>>('load_goals').catch");
  });

  it('only continues after an explicit resume and uses the normal submission path', () => {
    expect(continuationSource).toContain('export function resumeGoalExecution');
    expect(continuationSource).toContain("goal.status === 'paused' || goal.status === 'blocked'");
    expect(continuationSource).toContain("window.dispatchEvent(new CustomEvent('blackbox:goal-submit'");
    expect(continuationSource).toContain('captured?.turnId === turnId');
    expect(appSource).toContain("window.dispatchEvent(new CustomEvent('blackbox:goal-create'");
  });

  it('does not strand hidden control submissions in background animation frames or overwrite drafts', () => {
    const goalSubmission = inputSource.slice(
      inputSource.indexOf('// Goal creation/resume can come from the toolbar'),
      inputSource.indexOf('// Toolbar Loop actions'),
    );
    expect(goalSubmission).toContain('queueMicrotask(() =>');
    expect(goalSubmission).not.toContain('requestAnimationFrame(() => handleSubmitRef.current())');
    expect(goalSubmission).toContain('!tab.inputDraft.trim()');
    expect(goalSubmission).toContain('!isSessionBusy(tab.sessionStatus)');
    expect(goalSubmission).toContain("markWaiting(detail.tabId, 'needs_resume')");
    expect(goalSubmission).toContain("detail.prompt, 'continuation'");
    expect(goalSubmission).toContain('markTurnStarted(tabId, origin)');
  });

  it('keeps waiting time out of active elapsed time and exposes an explicit Resume path', () => {
    expect(storeSource).toContain('const waiting = closeActiveClock(existing)');
    expect(storeSource).toContain("existing?.status === 'active' && Boolean(existing.waitReason)");
    expect(storeSource).toContain('existing.currentTurnId) return undefined');
    expect(controlSource).toContain("goal.status === 'active' && goal.waitReason");
  });

  it('exposes deterministic toolbar controls to the native test harness', () => {
    expect(controlSource).toContain('data-testid="goal-explainer"');
    expect(controlSource).toContain('text-xs leading-relaxed');
    expect(controlSource).toContain('data-testid="goal-pause"');
    expect(controlSource).toContain('data-testid="goal-resume"');
    expect(cliSource).toContain("async 'goal-create'");
    expect(cliSource).toContain("async 'goal-pause'");
    expect(cliSource).toContain("async 'goal-resume'");
  });

  it('does not shadow Claude Code native /goal with the Codex-style Goal UI', () => {
    expect(inputSource).toContain("case 'codex-goal':");
    expect(inputSource).not.toContain("case 'goal':");
    expect(rustSource).toContain('"/codex-goal"');
    const blackBoxCatalog = rustSource.slice(
      rustSource.indexOf('let blackbox_commands:'),
      rustSource.indexOf('for (name, description, has_args) in blackbox_commands'),
    );
    expect(blackBoxCatalog).not.toContain('"/goal"');
    expect(commandStoreSource).toContain('for (const runtime of runtimeCommands)');
    expect(commandStoreSource).toContain("owner: runtime.owner || 'claude'");
  });

  it('keeps a Haiku-only native pause, relaunch, resume, and persistence smoke', () => {
    expect(smokeSource).toContain("cli(['switch-model', 'haiku'])");
    expect(smokeSource).toContain("cli(['goal-pause'])");
    expect(smokeSource).toContain("cli(['goal-resume'])");
    expect(smokeSource).toContain('noSurpriseContinuation');
    expect(smokeSource).toContain('completionPersisted');
    expect(smokeSource).toContain('assertNoPrivateToolAccess(report.jsonlPath, privateRoots)');
    expect(smokeSource).toContain('/opus|fable/i');
  });
});
