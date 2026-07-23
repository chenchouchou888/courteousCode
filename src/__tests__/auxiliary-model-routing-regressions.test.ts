import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bridge = readFileSync(resolve(__dirname, '../lib/tauri-bridge.ts'), 'utf8');
const inputBar = readFileSync(resolve(__dirname, '../components/chat/InputBar.tsx'), 'utf8');
const chatPanel = readFileSync(resolve(__dirname, '../components/chat/ChatPanel.tsx'), 'utf8');
const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
const historicalFork = readFileSync(resolve(__dirname, '../hooks/useHistoricalFork.ts'), 'utf8');
const backend = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const modelHook = readFileSync(resolve(__dirname, '../../src-tauri/src/auxiliary_model_hook.rs'), 'utf8');
const webMcp = readFileSync(resolve(__dirname, '../../src-tauri/src/web_retrieval_mcp.rs'), 'utf8');
const automations = readFileSync(resolve(__dirname, '../../src-tauri/src/automations.rs'), 'utf8');
const cli = readFileSync(resolve(__dirname, '../../scripts/blackbox-cli.mjs'), 'utf8');
const routingSmoke = readFileSync(resolve(__dirname, '../../scripts/provider-routing-smoke.mjs'), 'utf8');

describe('auxiliary model routing regressions', () => {
  it('captures and passes the provider-resolved auxiliary model on every interactive spawn path', () => {
    expect(bridge).toContain('auxiliary_model?: string');
    expect(inputBar).toContain('auxiliary_model: spawnConfig.auxiliaryModel');
    expect(chatPanel).toContain('auxiliary_model: spawnConfig.auxiliaryModel');
    expect(historicalFork).toContain('auxiliaryModel: config.auxiliaryModel');
  });

  it('pins every subagent independently of the Agent Teams opt-in', () => {
    const pin = backend.indexOf('"CLAUDE_CODE_SUBAGENT_MODEL".to_string()');
    const teamGate = backend.indexOf('if agent_teams_enabled {', pin);
    expect(pin).toBeGreaterThan(0);
    expect(teamGate).toBeGreaterThan(pin);
    expect(backend.slice(pin, teamGate)).toContain('auxiliary_model.clone()');
    expect(backend).toContain('"matcher": "Agent"');
    expect(backend).toContain('"--auxiliary-model-hook"');
    expect(modelHook).toContain('tool_input.insert("model".to_string()');
    expect(modelHook).toContain('permissionDecision": "allow"');
    expect(modelHook).toContain('BLACKBOX_DEV_AUXILIARY_MODEL_AUDIT_FILE');
    expect(modelHook).toContain('BLACKBOX_DEV_ISOLATION_ROOT');
    expect(modelHook).toContain('build_audit_record');
    expect(modelHook).not.toContain('"prompt": payload');
  });

  it('removes native web tools from the lead and exposes only isolated auxiliary retrieval', () => {
    expect(backend).toContain('"--disallowedTools".to_string()');
    expect(backend).toContain('"WebSearch,WebFetch".to_string()');
    expect(backend).toContain('"mcp__blackbox_web__research".to_string()');
    expect(backend).toContain('"blackbox_web".to_string()');
    expect(webMcp).toContain('"--model".to_string()');
    expect(webMcp).toContain('"--tools".to_string()');
    expect(webMcp).toContain('"WebSearch,WebFetch".to_string()');
    expect(webMcp).not.toContain('"Agent,Bash');
  });

  it('pins scheduled subagents and retrieval to the task auxiliary model', () => {
    expect(automations).toContain('pub auxiliary_model: Option<String>');
    expect(automations).toContain('resolve_provider_and_models(definition)');
    expect(automations).toContain('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(automations).toContain('build_mcp_scratch_config(&mcp_scratch_id, mcp_cwd, &auxiliary_model)');
    expect(automations).toContain('build_automation_security_settings(run_id, &auxiliary_model)');
  });

  it('exposes separate dev controls without deleting shared runtime transcripts', () => {
    expect(app).toContain('getCurrentAuxiliaryModel()');
    expect(app).toContain('switchAuxiliaryModel(modelId: string)');
    expect(app).toContain('await bridge.deleteSession(sessionId, session.path)');
    expect(app).toContain('detachedFromBlackBox: true');
    expect(app).toContain('sharedTranscriptPreserved: Boolean(session?.path)');
    expect(cli).toContain("'get-current-auxiliary-model'");
    expect(cli).toContain("'switch-auxiliary-model'");
    expect(cli).toContain("callAsyncHelper(client, 'deleteCurrentSession'");
  });

  it('keeps the live routing smoke on low-cost models and delegates residue cleanup to isolation', () => {
    expect(routingSmoke).toContain("const mainTier = process.env.BLACKBOX_SMOKE_MAIN_MODEL_TIER || 'sonnet'");
    expect(routingSmoke).toContain("const auxiliaryTier = process.env.BLACKBOX_SMOKE_AUX_MODEL_TIER || 'haiku'");
    expect(routingSmoke).toContain('/opus|fable/i.test(model)');
    expect(routingSmoke).toContain('record.enforcedModel === auxiliaryModel');
    expect(routingSmoke).toContain("cli(['delete-session']");
    expect(routingSmoke).toContain('report.checks.sharedSessionFilePreserved = existsSync(jsonlPath)');
    expect(routingSmoke).toContain('report.checks.sessionIndexDeleted');
  });
});
