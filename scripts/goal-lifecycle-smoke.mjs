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

const runId = `goal-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const goalsFile = join(resolve(process.env.HOME || ''), '.blackbox', 'goals.json');
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
  socketPath = `/tmp/blackbox-goal-lifecycle-${process.pid}-${launchIndex}.sock`;
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

async function waitForGoal(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = cli(['get-current-goal']).goal;
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`Goal did not reach expected state: ${JSON.stringify(last)}`);
}

async function waitForSessionRecord(threadId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = cli(['get-all-sessions']).sessions.find((item) => item.id === threadId) || null;
    if (last?.path) return last;
    await sleep(250);
  }
  throw new Error(`Session record did not expose its JSONL path: ${JSON.stringify(last)}`);
}

async function waitForGoalFile(marker, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(goalsFile) && readFileSync(goalsFile, 'utf8').includes(marker)) return true;
    await sleep(100);
  }
  throw new Error(`Goal file did not persist marker ${marker}`);
}

async function waitForPersistedGoal(threadId, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    if (existsSync(goalsFile)) {
      try {
        last = JSON.parse(readFileSync(goalsFile, 'utf8'))?.[threadId] || null;
        if (last && predicate(last)) return last;
      } catch {}
    }
    await sleep(100);
  }
  throw new Error(`Goal file did not persist expected state: ${JSON.stringify(last)}`);
}

function allMessages() {
  return cli(['get-messages', '--all', '--full']);
}

function toolNames(messages) {
  return messages
    .filter((message) => message?.type === 'tool_use')
    .map((message) => String(message.toolName || ''));
}

function messageText(messages) {
  return messages
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

const marker = `GOAL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const objective = [
  `This is a deterministic Black Box Goal lifecycle acceptance test (${marker}) in an isolated disposable workspace.`,
  'When the internal Goal wrapper has kind=start: use no tools, reply exactly FIRST_GOAL_TURN_SETTLED, then report blocked with evidence exactly FIRST_TURN_BLOCKED.',
  'When the internal Goal wrapper has kind=continuation: call Bash exactly once and use no other tool. In that Bash call, read RESUME_FLAG.txt from the current working directory and verify its entire contents equal RESUME_ALLOWED_MARKER.',
  'After that verification succeeds, reply exactly SECOND_GOAL_TURN_SETTLED, then report complete with evidence exactly RESUMED_GOAL_COMPLETE.',
  'Never inspect any other directory or file.',
].join(' ');

const report = {
  runId,
  workspace,
  reportFile,
  goalsFile,
  marker,
  modelTier: null,
  resolvedModel: null,
  providerId: null,
  uiThreadId: null,
  cliSessionId: null,
  jsonlPath: null,
  launches: [],
  firstTurnToolNames: [],
  resumedToolNames: [],
  pausedGoal: null,
  completedGoal: null,
  checks: {},
  passed: false,
};

try {
  writeFileSync(join(workspace, 'README.md'), '# Black Box Goal lifecycle smoke\n', 'utf8');
  report.launches.push(await startApp('initial'));
  await createDraft(workspace);
  cli(['switch-model', 'haiku']);
  report.modelTier = cli(['get-current-model']).model;
  report.providerId = cli(['get-current-provider']).provider;
  report.resolvedModel = cli(['get-visible-text', '--selector', '[data-testid="current-resolved-model"]']).text.trim();
  if (/opus|fable/i.test(report.resolvedModel) || !/haiku/i.test(report.resolvedModel)) {
    throw new Error(`Goal smoke requires Haiku: ${report.resolvedModel}`);
  }
  report.checks.haikuOnly = true;

  const beforeStart = allMessages();
  cli(['goal-create', objective]);
  await waitForGoal((goal) => goal.status === 'active' && Boolean(goal.currentTurnId));
  report.pausedGoal = cli(['goal-pause']).goal;
  if (report.pausedGoal?.status !== 'paused') {
    throw new Error(`Goal pause control returned ${report.pausedGoal?.status}`);
  }
  report.checks.pauseControl = true;

  const firstSettled = cli([
    'wait-until-done',
    '--timeout', String(timeoutMs),
    '--min-messages', String((beforeStart.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (firstSettled.status !== 'completed') {
    throw new Error(`Initial Goal turn did not settle: ${JSON.stringify(firstSettled)}`);
  }
  report.uiThreadId = await waitForRealSession();
  const pausedAfterPromotion = await waitForGoal(
    (goal) => goal.threadId === report.uiThreadId && goal.status === 'paused',
  );
  report.pausedGoal = pausedAfterPromotion;
  const afterFirst = allMessages();
  const firstMessages = afterFirst.messages.slice(beforeStart.total || 0);
  report.firstTurnToolNames = toolNames(firstMessages);
  if (report.firstTurnToolNames.length !== 0) {
    throw new Error(`Initial Goal turn used unexpected tools: ${JSON.stringify(report.firstTurnToolNames)}`);
  }
  if (!messageText(firstMessages).includes('FIRST_GOAL_TURN_SETTLED')) {
    throw new Error('Initial Goal turn did not emit its visible settlement marker');
  }
  report.checks.firstTurnSettledWithoutTools = true;

  const session = await waitForSessionRecord(report.uiThreadId);
  report.cliSessionId = session.cliResumeId || report.uiThreadId;
  report.jsonlPath = session.path;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  await waitForGoalFile(marker);
  report.checks.pausedStatePersisted = true;

  requestNativeClose();
  const firstCloseCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (firstCloseCode !== 0) throw new Error(`Native close exited with code ${firstCloseCode}`);
  report.checks.firstNativeCloseClean = true;

  report.launches.push(await startApp('paused-relaunch'));
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();
  const relaunchedPaused = await waitForGoal(
    (goal) => goal.threadId === report.uiThreadId && goal.status === 'paused',
  );
  const quietBefore = allMessages().total;
  await sleep(2_500);
  const quietAfter = allMessages().total;
  const quietStatus = cli(['status']);
  const quietGoal = cli(['get-current-goal']).goal;
  if (quietAfter !== quietBefore || quietStatus.active) {
    throw new Error(`Paused Goal changed after relaunch: ${JSON.stringify({ quietBefore, quietAfter, quietStatus })}`);
  }
  if (!messageText(allMessages().messages).includes('FIRST_GOAL_TURN_SETTLED')) {
    throw new Error('Initial Goal settlement marker did not hydrate after relaunch');
  }
  if (quietGoal?.status !== 'paused' || relaunchedPaused.waitReason !== 'interrupted') {
    throw new Error(`Relaunched Goal was not safely paused: ${JSON.stringify(quietGoal)}`);
  }
  report.checks.nativeRelaunchPaused = true;
  report.checks.noSurpriseContinuation = true;

  writeFileSync(join(workspace, 'RESUME_FLAG.txt'), 'RESUME_ALLOWED_MARKER\n', 'utf8');
  const beforeResume = allMessages();
  cli(['goal-resume']);
  report.completedGoal = await waitForGoal(
    (goal) => goal.status === 'completed'
      && goal.completionEvidence?.includes('RESUME_ALLOWED_MARKER'),
    timeoutMs,
  );
  const resumedSettled = cli([
    'wait-until-done',
    '--timeout', String(timeoutMs),
    '--min-messages', String((beforeResume.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (resumedSettled.status !== 'completed') {
    throw new Error(`Resumed Goal turn did not settle: ${JSON.stringify(resumedSettled)}`);
  }
  const afterResume = allMessages();
  const resumedMessages = afterResume.messages.slice(beforeResume.total || 0);
  report.resumedToolNames = toolNames(resumedMessages);
  if (report.resumedToolNames.length !== 1 || report.resumedToolNames[0].toLowerCase() !== 'bash') {
    throw new Error(`Resumed Goal expected exactly one Bash call: ${JSON.stringify(report.resumedToolNames)}`);
  }
  if (!messageText(resumedMessages).includes('SECOND_GOAL_TURN_SETTLED')) {
    throw new Error('Resumed Goal turn did not emit its visible settlement marker');
  }
  if (report.completedGoal.continuationTurns !== 1 || report.completedGoal.turns !== 1) {
    throw new Error(`Goal turn accounting is unexpected: ${JSON.stringify(report.completedGoal)}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  await waitForPersistedGoal(
    report.uiThreadId,
    (goal) => goal.status === 'completed'
      && goal.completionEvidence?.includes('RESUME_ALLOWED_MARKER'),
  );
  report.checks.resumeCompleted = true;
  report.checks.singleBashAfterResume = true;
  report.checks.noPrivateWorkspaceAccess = true;

  requestNativeClose();
  const secondCloseCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (secondCloseCode !== 0) throw new Error(`Second native close exited with code ${secondCloseCode}`);
  report.checks.secondNativeCloseClean = true;

  report.launches.push(await startApp('completed-relaunch'));
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();
  const persistedCompletion = await waitForGoal(
    (goal) => goal.threadId === report.uiThreadId
      && goal.status === 'completed'
      && goal.completionEvidence?.includes('RESUME_ALLOWED_MARKER'),
  );
  const finalBefore = allMessages();
  await sleep(2_000);
  const finalAfter = allMessages();
  if (finalAfter.total !== finalBefore.total || cli(['status']).active) {
    throw new Error('Completed Goal changed or resumed after final relaunch');
  }
  if (!messageText(finalAfter.messages).includes('SECOND_GOAL_TURN_SETTLED')) {
    throw new Error('Completed Goal settlement marker did not hydrate after relaunch');
  }
  const finalSession = await waitForSessionRecord(report.uiThreadId);
  const finalCliSessionId = finalSession.cliResumeId || report.uiThreadId;
  if (finalCliSessionId !== report.cliSessionId) {
    throw new Error(`CLI UUID changed: ${report.cliSessionId} -> ${finalCliSessionId}`);
  }
  if (finalSession.path !== report.jsonlPath) {
    throw new Error(`JSONL path changed: ${report.jsonlPath} -> ${finalSession.path}`);
  }
  if (persistedCompletion.turns !== report.completedGoal.turns) {
    throw new Error('Persisted Goal turn count changed after relaunch');
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.completionPersisted = true;
  report.checks.identityStable = true;

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
