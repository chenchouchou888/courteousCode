#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExternalExecutionRoot,
  assertNoPrivateToolAccess,
  configuredPrivateRoots,
} from './isolation-guard.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoots = configuredPrivateRoots(projectRoot);
const cliPath = join(projectRoot, 'scripts', 'blackbox-cli.mjs');
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationHome = process.env.BLACKBOX_AUTOMATION_HOME;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || automationHome;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 180_000);

for (const [value, label] of [
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
  [automationHome, 'BLACKBOX_AUTOMATION_HOME'],
  [reportHome, 'BLACKBOX_SMOKE_REPORT_HOME'],
]) {
  if (!value) throw new Error(`${label} is required; run through scripts/run-isolated.sh`);
}
assertExternalExecutionRoot(isolationRoot, privateRoots);

const runId = `plan-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const plansFile = join(resolve(process.env.HOME || ''), '.blackbox', 'plans.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

let appProcess = null;
let socketPath = null;
let launchIndex = 0;

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || workspace,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout || '';
}

function cli(args, options = {}) {
  if (!socketPath) throw new Error('Black Box app socket is not active');
  const stdout = runProcess(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    timeout: options.timeout || timeoutMs,
    env: { BLACKBOX_SOCKET: socketPath },
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines.at(-1) || '{}');
  if (!payload.ok) throw new Error(payload.error || `CLI command failed: ${args.join(' ')}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHarness() {
  const deadline = Date.now() + 90_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return cli(['status'], { timeout: 5_000 });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
    }
  }
  throw new Error(`Black Box page harness did not become ready: ${lastError}`);
}

async function startApp(label) {
  if (appProcess && appProcess.exitCode == null) throw new Error('Black Box dev app is already running');
  launchIndex += 1;
  socketPath = `/tmp/blackbox-plan-lifecycle-${process.pid}-${launchIndex}.sock`;
  const logFile = join(runRoot, `app-${launchIndex}-${label}.log`);
  const logFd = openSync(logFile, 'a');
  appProcess = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: projectRoot,
    env: { ...process.env, BLACKBOX_SOCKET: socketPath },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  await waitForHarness();
  return { socketPath, logFile, pid: appProcess.pid };
}

async function waitForAppExit(timeout = 30_000) {
  const child = appProcess;
  if (!child || child.exitCode != null) return child?.exitCode ?? 0;
  return await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      rejectPromise(new Error(`Black Box dev app did not exit within ${timeout}ms`));
    }, timeout);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolvePromise(code ?? (signal ? -1 : 0));
    };
    child.once('exit', onExit);
  });
}

function requestNativeClose() {
  try {
    cli(['exec', 'window.__blackbox_test.closeWindow()']);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Native close can tear down the test socket before its last response is
    // flushed. The process exit code below remains the authoritative result.
    if (!/Socket (?:connection ended|closed by BLACKBOX)|socket not found/i.test(message)) {
      throw error;
    }
  }
}

async function closeAppGracefully() {
  if (!appProcess || appProcess.exitCode != null) return;
  requestNativeClose();
  const exitCode = await waitForAppExit();
  if (exitCode !== 0) throw new Error(`Black Box dev app exited with code ${exitCode}`);
  appProcess = null;
  socketPath = null;
}

async function forceStopApp() {
  if (!appProcess || appProcess.exitCode != null) return;
  try { appProcess.kill('SIGTERM'); } catch {}
  try {
    await waitForAppExit(10_000);
  } catch {
    try { appProcess.kill('SIGKILL'); } catch {}
  }
  appProcess = null;
  socketPath = null;
}

async function createDraft(cwd) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    cli(['new-session', '--cwd', cwd]);
    await sleep(300);
    last = cli(['check-editor']);
    if (last.editorReady && last.session) return last;
    await sleep(500);
  }
  throw new Error(`Could not create a stable draft session: ${JSON.stringify(last)}`);
}

async function waitForEditor() {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = cli(['check-editor']);
    if (last.editorReady && last.session) return last;
    await sleep(250);
  }
  throw new Error(`Editor did not become ready: ${JSON.stringify(last)}`);
}

async function waitForRealSession() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = cli(['get-active-session']).session;
    if (current && !current.startsWith('draft_')) return current;
    await sleep(250);
  }
  throw new Error('Draft session was not promoted to a durable session');
}

async function waitForSelectedSession(expected) {
  const deadline = Date.now() + 30_000;
  let current = null;
  while (Date.now() < deadline) {
    current = cli(['get-active-session']).session;
    if (current === expected) return current;
    await sleep(250);
  }
  throw new Error(`Expected selected session ${expected}, received ${current}`);
}

async function waitForPlan(expectedThreadId, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = cli(['get-current-plan']).plan;
    if (last?.threadId === expectedThreadId && predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`Plan did not reach expected state: ${JSON.stringify(last)}`);
}

function allMessages() {
  return cli(['get-messages', '--all', '--full']);
}

async function sendPrompt(prompt) {
  const before = allMessages();
  cli(['type', prompt]);
  cli(['send']);
  const settled = cli([
    'wait-until-done',
    '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') throw new Error(`Prompt did not complete: ${JSON.stringify(settled)}`);
  const after = allMessages();
  return { messages: after.messages.slice(before.total || 0), all: after };
}

function toolNames(messages) {
  return messages
    .filter((message) => message?.type === 'tool_use')
    .map((message) => String(message.toolName || ''));
}

function assertOnlyPlanTool(messages, label) {
  const names = toolNames(messages);
  const planNames = names.filter((name) => name.replace(/-/g, '_') === 'mcp__blackbox_plan__update_plan');
  if (planNames.length !== 1 || names.length !== 1) {
    throw new Error(`${label} expected exactly one update_plan call, received ${JSON.stringify(names)}`);
  }
  return names[0];
}

function assertPlan(plan, expected) {
  if (!plan) throw new Error('Plan is missing');
  if (plan.explanation !== expected.explanation) {
    throw new Error(`Unexpected Plan explanation: ${plan.explanation}`);
  }
  const actual = plan.items.map(({ step, status }) => ({ step, status }));
  if (JSON.stringify(actual) !== JSON.stringify(expected.items)) {
    throw new Error(`Unexpected Plan items: ${JSON.stringify(actual)}`);
  }
}

async function waitForPlanFile(marker, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(plansFile) && readFileSync(plansFile, 'utf8').includes(marker)) return true;
    await sleep(100);
  }
  throw new Error(`Plan file did not persist marker ${marker}`);
}

const marker = `PLAN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const steps = [
  `Inspect ${marker}`,
  `Persist ${marker}`,
  `Finish ${marker}`,
];
const phaseOne = {
  explanation: `Phase 1 ${marker}`,
  items: [
    { step: steps[0], status: 'in_progress' },
    { step: steps[1], status: 'pending' },
    { step: steps[2], status: 'pending' },
  ],
};
const phaseTwo = {
  explanation: `Phase 2 ${marker}`,
  items: [
    { step: steps[0], status: 'completed' },
    { step: steps[1], status: 'in_progress' },
    { step: steps[2], status: 'pending' },
  ],
};

const report = {
  runId,
  workspace,
  reportFile,
  plansFile,
  marker,
  modelTier: null,
  resolvedModel: null,
  providerId: null,
  uiThreadId: null,
  cliSessionId: null,
  jsonlPath: null,
  launches: [],
  toolNames: [],
  revisions: [],
  checks: {},
  passed: false,
};

try {
  writeFileSync(join(workspace, 'README.md'), '# Black Box Plan lifecycle smoke\n', 'utf8');
  report.launches.push(await startApp('initial'));
  await createDraft(workspace);
  cli(['switch-model', 'haiku']);
  report.modelTier = cli(['get-current-model']).model;
  report.providerId = cli(['get-current-provider']).provider;
  report.resolvedModel = cli(['get-visible-text', '--selector', '[data-testid="current-resolved-model"]']).text.trim();
  if (/opus|fable/i.test(report.resolvedModel) || !/haiku|sonnet/i.test(report.resolvedModel)) {
    throw new Error(`Plan smoke requires Haiku or Sonnet: ${report.resolvedModel}`);
  }

  const firstTurn = await sendPrompt([
    'This is a mechanical Black Box Plan acceptance test.',
    'Call the built-in mcp__blackbox_plan__update_plan tool exactly once and use no other tool.',
    `Set explanation to exactly: ${phaseOne.explanation}`,
    'Set these three Plan items exactly:',
    `1. ${steps[0]} — in_progress`,
    `2. ${steps[1]} — pending`,
    `3. ${steps[2]} — pending`,
    'Then reply exactly PLAN_PHASE_ONE_READY.',
  ].join('\n'));
  report.toolNames.push(assertOnlyPlanTool(firstTurn.messages, 'Phase one'));
  report.uiThreadId = await waitForRealSession();
  const firstPlan = await waitForPlan(report.uiThreadId, (plan) => plan.explanation === phaseOne.explanation);
  assertPlan(firstPlan, phaseOne);
  report.revisions.push(firstPlan.revision);
  report.checks.firstUpdateCaptured = true;

  const session = cli(['get-all-sessions']).sessions.find((item) => item.id === report.uiThreadId);
  report.cliSessionId = session?.cliResumeId || report.uiThreadId;
  report.jsonlPath = session?.path || null;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);

  const opened = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="plan-toggle-button"]');if(!button)return {error:'missing toggle'};button.click();return {clicked:true}})()`]).result;
  if (opened?.error) throw new Error(opened.error);
  const panel = cli(['exec', `(()=>{const panel=document.querySelector('[data-testid="persistent-plan"]');return panel?{text:panel.innerText,statuses:[...panel.querySelectorAll('[data-plan-status]')].map((el)=>el.getAttribute('data-plan-status'))}:{error:'missing panel'}})()`]).result;
  if (panel?.error || !steps.every((step) => panel.text.includes(step))) {
    throw new Error(`Persistent Plan panel did not render expected steps: ${JSON.stringify(panel)}`);
  }
  if (JSON.stringify(panel.statuses) !== JSON.stringify(phaseOne.items.map((item) => item.status))) {
    throw new Error(`Persistent Plan panel statuses mismatch: ${JSON.stringify(panel.statuses)}`);
  }
  report.checks.panelRendered = true;

  const secondTurn = await sendPrompt([
    'Update the same Black Box Plan now.',
    'Call the built-in mcp__blackbox_plan__update_plan tool exactly once and use no other tool.',
    `Set explanation to exactly: ${phaseTwo.explanation}`,
    'Set these three Plan items exactly:',
    `1. ${steps[0]} — completed`,
    `2. ${steps[1]} — in_progress`,
    `3. ${steps[2]} — pending`,
    'Then reply exactly PLAN_PHASE_TWO_READY.',
  ].join('\n'));
  report.toolNames.push(assertOnlyPlanTool(secondTurn.messages, 'Phase two'));
  const secondPlan = await waitForPlan(report.uiThreadId, (plan) => plan.explanation === phaseTwo.explanation);
  assertPlan(secondPlan, phaseTwo);
  if (secondPlan.revision <= firstPlan.revision) throw new Error('Plan revision did not advance');
  report.revisions.push(secondPlan.revision);
  await waitForPlanFile(marker);
  report.checks.secondUpdateCaptured = true;
  report.checks.atomicFilePersisted = true;

  cli(['restart', '--timeout', '30000'], { timeout: 40_000 });
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();
  const reloadedPlan = await waitForPlan(report.uiThreadId, (plan) => plan.explanation === phaseTwo.explanation);
  assertPlan(reloadedPlan, phaseTwo);
  report.checks.webviewReloadPersisted = true;

  requestNativeClose();
  const closeCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (closeCode !== 0) throw new Error(`Native close exited with code ${closeCode}`);
  report.checks.nativeCloseExitClean = true;
  report.launches.push(await startApp('relaunch'));
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();
  const relaunchedPlan = await waitForPlan(report.uiThreadId, (plan) => plan.explanation === phaseTwo.explanation);
  assertPlan(relaunchedPlan, phaseTwo);
  report.checks.nativeRelaunchPersisted = true;

  const finalSession = cli(['get-all-sessions']).sessions.find((item) => item.id === report.uiThreadId);
  const finalCliSessionId = finalSession?.cliResumeId || report.uiThreadId;
  if (finalCliSessionId !== report.cliSessionId) {
    throw new Error(`CLI UUID changed: ${report.cliSessionId} -> ${finalCliSessionId}`);
  }
  if (finalSession?.path && report.jsonlPath && finalSession.path !== report.jsonlPath) {
    throw new Error(`JSONL path changed: ${report.jsonlPath} -> ${finalSession.path}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.identityStable = true;
  report.checks.noPrivateWorkspaceAccess = true;
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    await closeAppGracefully();
  } catch {
    await forceStopApp();
  }
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
