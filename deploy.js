#!/usr/bin/env node
'use strict';

// Local deployment. No Docker, no cloud -- just this machine.
// Written in Node rather than bash so macOS, Linux and Windows all run the
// same pipeline. Node is already a prerequisite; a second one is not.
//
//   node deploy.js            build + deploy the current working tree
//   node deploy.js status     is it up, and what is it running?
//   node deploy.js logs       show the running app's log
//   node deploy.js stop       stop it
//   node deploy.js rollback   redeploy the previously deployed commit

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = __dirname;
const RUN_DIR = path.join(ROOT, '.run');
const PID_FILE = path.join(RUN_DIR, 'app.pid');
const LOG_FILE = path.join(RUN_DIR, 'app.log');
const PREV_FILE = path.join(RUN_DIR, 'previous-commit');
const BUILD_FILE = path.join(ROOT, 'build-info.json');

const PORT = Number(process.env.PORT) || 3000;
const IS_WINDOWS = process.platform === 'win32';

// Windows terminals understand ANSI from Windows 10 on, but a bare cmd.exe on
// an older box does not -- and a wall of escape codes is worse than plain text.
const COLOR = Boolean(process.stdout.isTTY) &&
  !(IS_WINDOWS && !process.env.WT_SESSION && !process.env.TERM);
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

const say = (m) => console.log(`${c('1;34', '==>')} ${m}`);
const ok = (m) => console.log(`${c('1;32', '  ✔')} ${m}`);
const info = (m) => console.log(`     ${m}`);
function die(m) {
  console.error(`${c('1;31', '  ✘')} ${m}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

function git(args, fallback = null) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching it
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

async function stopApp() {
  const pid = readPid();
  if (pid !== null && isAlive(pid)) {
    if (IS_WINDOWS) {
      // Windows has no real SIGTERM; taskkill /T also gets any child processes.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }

    for (let i = 0; i < 25 && isAlive(pid); i++) await sleep(100);
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    ok(`stopped pid ${pid}`);
  }
  fs.rmSync(PID_FILE, { force: true });
}

// Binding the port ourselves is the one portable way to ask "is this free?"
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '0.0.0.0');
  });
}

// Best effort only -- naming the squatter is a nicety, not a requirement.
function whoHasPort(port) {
  try {
    if (IS_WINDOWS) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      const line = out.split(/\r?\n/).find(
        (l) => /LISTENING/.test(l) && new RegExp(`[:.]${port}\\s`).test(l));
      if (!line) return null;
      const pid = line.trim().split(/\s+/).pop();
      const tasks = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8' });
      return `${tasks.split(',')[0].replace(/"/g, '')} (pid ${pid})`;
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n')[1];
    if (!line) return null;
    const [cmd, pid] = line.trim().split(/\s+/);
    return `${cmd} (pid ${pid})`;
  } catch {
    return null;
  }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function tailLog(lines = 15) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
    if (text.length) {
      info(`last lines of ${path.relative(ROOT, LOG_FILE)}:`);
      for (const l of text) info(`  ${l}`);
    }
  } catch { /* no log yet */ }
}

// ---------------------------------------------------------------- commands

async function cmdStop() {
  say('Stopping');
  await stopApp();
}

async function cmdStatus() {
  const pid = readPid();
  if (pid !== null && isAlive(pid)) {
    ok(`running as pid ${pid} on http://localhost:${PORT}`);
    try { console.log(fs.readFileSync(BUILD_FILE, 'utf8')); } catch { /* no build yet */ }
  } else {
    console.log('not running');
  }
}

function cmdLogs() {
  try {
    process.stdout.write(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    console.log('no log yet -- deploy first');
  }
  // `tail -f` has no portable equivalent, so point at it rather than fake it.
  info(IS_WINDOWS
    ? 'follow it with:  Get-Content .run\\app.log -Wait'
    : 'follow it with:  tail -f .run/app.log');
}

async function cmdRollback() {
  let target = '';
  try {
    target = fs.readFileSync(PREV_FILE, 'utf8').trim();
  } catch { /* handled below */ }
  if (!target) die('no previous deploy recorded -- nothing to roll back to');

  const dirty = git(['diff', '--quiet'], 'dirty') === 'dirty' ||
                git(['diff', '--cached', '--quiet'], 'dirty') === 'dirty';
  if (dirty) die("you have uncommitted changes -- commit or 'git stash' them before rolling back");

  say(`Rolling back to ${target}`);
  if (git(['checkout', '--detach', target], null) === null) {
    die(`cannot check out ${target} (was it rewritten or garbage-collected?)`);
  }
  ok(`working tree is now at ${target} (detached HEAD -- 'git switch main' to come back)`);
  await cmdDeploy();
}

async function cmdDeploy() {
  // ------------------------------------------------------------ 1. verify
  say('Running tests');
  const tests = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  if (tests.status !== 0) {
    info('test output:');
    // Node prints each failure twice -- once inline, once in the summary.
    const failures = [...new Set(String(tests.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(not ok|✖)/.test(l) && !/^✖ (failing tests:|.*\btests\b \()/.test(l)))]
      .slice(0, 15);
    for (const l of failures) info(`  ${l.trim()}`);
    die('tests failed -- fix them before deploying (run: npm test)');
  }
  ok('tests passed');

  // ------------------------------------------------------------ 2. build
  say('Stamping build metadata');
  const commit = git(['rev-parse', '--short', 'HEAD'], 'no-git');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], 'no-git');
  const subject = git(['log', '-1', '--pretty=%s'], 'no commits yet');
  const tag = git(['describe', '--tags', '--exact-match'], null);

  let fileVersion = '0.0.0';
  try { fileVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() || '0.0.0'; } catch { /* default */ }
  const version = tag || fileVersion;

  fs.mkdirSync(RUN_DIR, { recursive: true });

  // Remember what is live right now, so rollback has somewhere to go.
  try {
    const live = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'));
    if (live.commit && live.commit !== 'no-git') fs.writeFileSync(PREV_FILE, live.commit);
  } catch { /* first deploy */ }

  fs.writeFileSync(BUILD_FILE, JSON.stringify({
    version, branch, commit, subject, deployedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  ok(`version ${version} @ ${commit} (${branch})`);

  // ------------------------------------------------------------ 3. release
  say(`Restarting app on port ${PORT}`);
  await stopApp();

  if (await portInUse(PORT)) {
    const who = whoHasPort(PORT);
    info(`port ${PORT} is held by another process${who ? `: ${who}` : ''}`);
    die(`free it, or deploy elsewhere:  ${IS_WINDOWS
      ? 'set PORT=3100 && npm run deploy'
      : 'PORT=3100 npm run deploy'}`);
  }

  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    detached: true,                 // escape our process group; on Windows a non-detached child is killed when the parent exits
    windowsHide: true,              // Windows: no flash of a console window
    stdio: ['ignore', log, log],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  ok(`started pid ${child.pid}`);

  // ------------------------------------------------------------ 4. verify
  say('Health check');
  for (let i = 0; i < 30; i++) {
    const body = await health(PORT);
    if (body) {
      ok(`healthy: ${body}`);
      console.log(`\n${c('1;32', 'Deployed.')} Open http://localhost:${PORT}`);
      return;
    }
    await sleep(200);
  }
  tailLog();
  die('app did not become healthy');
}

// ---------------------------------------------------------------- dispatch

const COMMANDS = {
  deploy: cmdDeploy, status: cmdStatus, logs: cmdLogs, stop: cmdStop, rollback: cmdRollback,
};

const command = process.argv[2] ?? 'deploy';
const handler = COMMANDS[command];
if (!handler) die(`unknown command: ${command} (try: ${Object.keys(COMMANDS).join(' | ')})`);

Promise.resolve(handler()).catch((err) => die(err.message));
