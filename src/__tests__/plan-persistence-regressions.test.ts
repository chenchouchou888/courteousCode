import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const streamSource = readFileSync(resolve(root, 'hooks/useStreamProcessor.ts'), 'utf8');
const appSource = readFileSync(resolve(root, 'App.tsx'), 'utf8');
const chatSource = readFileSync(resolve(root, 'components/chat/ChatPanel.tsx'), 'utf8');
const inputSource = readFileSync(resolve(root, 'components/chat/InputBar.tsx'), 'utf8');
const rustSource = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const cliSource = readFileSync(resolve(root, '../scripts/blackbox-cli.mjs'), 'utf8');
const smokeSource = readFileSync(resolve(root, '../scripts/plan-lifecycle-smoke.mjs'), 'utf8');
const identitySource = readFileSync(resolve(root, 'lib/session-identity.ts'), 'utf8');

describe('persistent Plan integration regressions', () => {
  it('captures root TodoWrite updates but excludes teammate/subagent plans', () => {
    expect(streamSource).toContain("block.name === 'TodoWrite'");
    expect(streamSource).toContain('bgAgentDepth === 0 && !msg.parent_tool_use_id');
    expect(streamSource).toContain('agentDepth === 0 && !msg.parent_tool_use_id');
    expect(streamSource).toContain("setPlan(tabId, block.input.todos, undefined, 'todo')");
  });

  it('captures the reserved built-in MCP update_plan tool as the current Plan', () => {
    expect(streamSource).toContain('isBlackBoxUpdatePlanTool(block.name)');
    expect(streamSource).toContain("block.input?.plan");
    expect(streamSource).toContain("'update_plan'");
    expect(streamSource).toContain('Ignored invalid update_plan input');
    expect(rustSource).toContain('"blackbox_plan".to_string()');
    expect(rustSource).not.toContain('"blackbox-plan".to_string()');
  });

  it('moves Plan authority with draft-to-real thread promotion', () => {
    expect(streamSource).toContain('captureCliSessionIdentity');
    expect(identitySource).toContain('usePlanStore.getState().movePlan(currentTabId, durableId)');
  });

  it('loads and renders the durable Plan control plane', () => {
    expect(appSource).toContain('usePlanStore.getState().loadPlans()');
    expect(chatSource).toContain('data-testid="persistent-plan"');
    expect(chatSource).toContain('getPlanProgress(plan.items)');
    expect(inputSource).toContain('data-testid="plan-toggle-button"');
  });

  it('uses bounded atomic application storage separate from Goal state', () => {
    expect(rustSource).toContain('blackbox_data_path("plans.json")');
    expect(rustSource).toContain('Plans payload exceeds the 1 MiB safety limit');
    expect(rustSource).toContain('Failed to atomically replace plans file');
  });

  it('keeps a Haiku/Sonnet-only real lifecycle smoke for Plan capture and persistence', () => {
    expect(cliSource).toContain("async 'get-current-plan'");
    expect(smokeSource).toContain("cli(['switch-model', 'haiku'])");
    expect(smokeSource).toContain('mcp__blackbox_plan__update_plan');
    expect(smokeSource).toContain('webviewReloadPersisted');
    expect(smokeSource).toContain('nativeRelaunchPersisted');
    expect(smokeSource).toContain('configuredPrivateRoots(projectRoot)');
    expect(smokeSource).toContain('assertNoPrivateToolAccess(report.jsonlPath, privateRoots)');
    expect(smokeSource).toContain('/opus|fable/i');
  });
});
