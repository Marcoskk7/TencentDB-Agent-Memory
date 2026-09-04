#!/usr/bin/env node
/** Explicit local collection; never uploads patches, command arguments, or process output. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const MAX_DIFF_BYTES = 20 * 1024 * 1024;

async function git(repo, ...args) {
  return (await exec('git', args, { cwd: repo, maxBuffer: MAX_DIFF_BYTES, encoding: 'buffer' })).stdout;
}

async function workspaceDiff(repo, baseCommit) {
  const patch = await git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--binary', baseCommit, '--');
  const tracked = (await git(repo, 'diff', '--no-ext-diff', '--name-only', '-z', baseCommit, '--')).toString().split('\0').filter(Boolean);
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).toString().split('\0').filter(Boolean).sort();
  const hashes = [];
  let bytes = patch.length;
  for (const name of untracked) {
    const file = path.join(repo, name);
    const stat = await lstat(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported untracked file; diff unavailable');
    bytes += stat.size;
    if (bytes > MAX_DIFF_BYTES) throw new Error('Workspace diff exceeds capture limit; nothing uploaded');
    const content = stat.isSymbolicLink() ? await readlink(file) : await readFile(file);
    hashes.push([name, digest(content)]);
  }
  return {
    base_commit: baseCommit,
    head_commit: (await git(repo, 'rev-parse', 'HEAD')).toString().trim(),
    files: [...new Set([...tracked, ...untracked])].sort(),
    diff_digest: digest(JSON.stringify([digest(patch), hashes])),
  };
}

async function execute(command, repo, timeoutMs, stdio) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EVIDENCE_')));
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command[0], command.slice(1), { cwd: repo, env, stdio, shell: false, detached: grouped });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process may have already exited. */ }
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Validation command could not start')); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

export async function collectWorkspaceEvidence({ repo, baseRef, command, timeoutMs = 120_000, stdio = 'inherit' }) {
  if (!Array.isArray(command) || !command.length) throw new Error('Explicit validation command required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Positive timeout required');
  const root = (await git(repo, 'rev-parse', '--show-toplevel')).toString().trim();
  if (await realpath(repo) !== await realpath(root)) throw new Error('--repo must identify the Git repository root');
  const baseCommit = (await git(repo, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`)).toString().trim();
  const before = await workspaceDiff(root, baseCommit);
  const result = await execute(command, root, timeoutMs, stdio);
  const diff = await workspaceDiff(root, baseCommit);
  const unchanged = before.diff_digest === diff.diff_digest && before.head_commit === diff.head_commit;
  const passed = result.code === 0 && !result.signal && !result.timedOut && unchanged;
  const status = result.timedOut ? 'timeout' : result.signal ? 'terminated' : !unchanged ? 'workspace_changed_during_validation' : `exit_code=${result.code}`;
  return {
    diff,
    behavior: {
      tool_name: 'workspace_command', target_files: diff.files,
      command_summary: 'Local validation command (arguments redacted)',
      result_summary: status,
    },
    validation: {
      command: 'Local validation command (arguments redacted)',
      ...(Number.isInteger(result.code) ? { exit_code: result.code } : {}),
      passed, validation_type: 'test', verifier: 'local-workspace-collector',
    },
  };
}

export function parseArguments(argv) {
  const options = { repo: process.cwd(), claimIds: [], close: false, timeoutMs: 120_000, command: [] };
  const fields = { '--repo': 'repo', '--run-id': 'runId', '--base-ref': 'baseRef', '--timeout-ms': 'timeoutMs' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { options.command = argv.slice(i + 1); break; }
    if (arg === '--close') { options.close = true; continue; }
    if (arg !== '--claim-id' && !fields[arg]) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
    if (arg === '--claim-id') options.claimIds.push(value);
    else options[fields[arg]] = arg === '--timeout-ms' ? Number(value) : value;
  }
  if (!options.runId) throw new Error('--run-id required');
  if (!options.claimIds.length) throw new Error('At least one explicit --claim-id required');
  if (!options.command.length) throw new Error('Explicit command after -- required');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('Invalid timeout');
  options.repo = path.resolve(options.repo);
  options.claimIds = [...new Set(options.claimIds)];
  return options;
}

export function coreClient(env = process.env) {
  for (const key of ['EVIDENCE_CORE_URL', 'EVIDENCE_SERVICE_ID', 'EVIDENCE_GATEWAY_KEY', 'EVIDENCE_USER_KEY']) {
    if (!env[key]) throw new Error(`${key} required`);
  }
  const endpoint = new URL(env.EVIDENCE_CORE_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid Core endpoint');
  return async (route, body) => {
    const response = await fetch(`${endpoint.toString().replace(/\/$/, '')}/v3/evidence/${route}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json', Authorization: `Bearer ${env.EVIDENCE_GATEWAY_KEY}`,
        'x-tdai-service-id': env.EVIDENCE_SERVICE_ID, 'x-tdai-user-key': env.EVIDENCE_USER_KEY,
      },
      body: JSON.stringify(body),
    });
    const envelope = await response.json();
    if (!response.ok || envelope.code !== 0) throw new Error(`Core ${route} rejected capture (code ${envelope.code ?? response.status})`);
    return envelope.data;
  };
}

export async function captureAndRecord(options, post) {
  const snapshot = await post('task-runs/get', { run_id: options.runId });
  if (snapshot.run.status !== 'running') throw new Error('Run is closed; command was not executed');
  for (const claimId of options.claimIds) {
    if (!snapshot.claims.some(claim => claim.claim_id === claimId && claim.run_id === options.runId)) throw new Error('Claim does not belong to run; command was not executed');
  }
  const baseRef = options.baseRef ?? snapshot.run.base_commit;
  if (!baseRef) throw new Error('--base-ref required when the Run has no baseline');
  const resolvedBase = (await git(options.repo, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`)).toString().trim();
  if (snapshot.run.base_commit && snapshot.run.base_commit !== resolvedBase) throw new Error('Baseline differs from Run; command was not executed');
  const evidence = await collectWorkspaceEvidence({ ...options, baseRef: resolvedBase });
  const captureId = randomUUID();
  const write = (kind, body) => post(`task-runs/${kind}`, { run_id: options.runId, idempotency_key: `workspace:${captureId}:${kind}`, ...body });
  const behavior = await write('behaviors', evidence.behavior);
  const diff = evidence.diff.files.length ? await write('diffs', evidence.diff) : null;
  const validation = await write('validations', {
    ...evidence.validation, claim_refs: options.claimIds,
    behavior_refs: [behavior.behavior_id], diff_refs: diff ? [diff.diff_id] : [],
  });
  const receipt = options.close
    ? await post('task-runs/close', { run_id: options.runId, close_reason: 'Explicit local workspace capture complete' })
    : await post('task-runs/receipt', { run_id: options.runId });
  return { run_id: options.runId, validation_id: validation.validation_id, passed: evidence.validation.passed, closed: options.close, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/evidence-workspace.mjs --run-id RUN --claim-id CLAIM [--claim-id CLAIM] [--repo ROOT] [--base-ref COMMIT] [--timeout-ms MS] [--close] -- COMMAND [ARGS...]\nRequired environment: EVIDENCE_CORE_URL, EVIDENCE_SERVICE_ID, EVIDENCE_GATEWAY_KEY, EVIDENCE_USER_KEY.\nRuns COMMAND locally without a shell. Uploads only file names, digests, and execution status. Explicitly select the claims this validation checks.');
  } else {
    try {
      const result = await captureAndRecord(parseArguments(process.argv.slice(2)), coreClient());
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
      console.error(`Evidence capture failed: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
