import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureAndRecord, collectWorkspaceEvidence, parseArguments } from './evidence-workspace.mjs';

async function repository(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evidence-workspace-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  try {
    git('init');
    git('config', 'user.email', 'evidence-test@example.invalid');
    git('config', 'user.name', 'Evidence Test');
    await writeFile(path.join(dir, 'source.txt'), 'before\n');
    git('add', 'source.txt');
    git('commit', '-m', 'test baseline');
    await fn(dir, git('rev-parse', 'HEAD'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('captures actual command result and tracked/untracked diff without secret contents', async () => {
  await repository(async (repo, baseRef) => {
    await writeFile(path.join(repo, 'source.txt'), 'private-api-key=DO_NOT_UPLOAD\n');
    await writeFile(path.join(repo, 'new.txt'), 'private untracked contents\n');
    const result = await collectWorkspaceEvidence({
      repo, baseRef, command: [process.execPath, '-e', 'process.exit(0)'], stdio: 'ignore',
    });
    assert.equal(result.validation.exit_code, 0);
    assert.equal(result.validation.passed, true);
    assert.deepEqual(result.diff.files, ['new.txt', 'source.txt']);
    assert.equal(result.diff.base_commit, baseRef);
    assert.match(result.diff.diff_digest, /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_UPLOAD|private untracked|process\.exit/);
  });
});

test('nonzero exit and timeout cannot become a passing validation', async () => {
  await repository(async (repo, baseRef) => {
    const failed = await collectWorkspaceEvidence({
      repo, baseRef, command: [process.execPath, '-e', 'process.exit(7)'], stdio: 'ignore',
    });
    assert.equal(failed.validation.exit_code, 7);
    assert.equal(failed.validation.passed, false);
    const timeout = await collectWorkspaceEvidence({
      repo, baseRef, command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 50, stdio: 'ignore',
    });
    assert.equal(timeout.validation.passed, false);
    assert.equal(timeout.validation.exit_code, undefined);
  });
});

test('capture credentials are not inherited by the validation process', async () => {
  await repository(async (repo, baseRef) => {
    const previous = process.env.EVIDENCE_USER_KEY;
    process.env.EVIDENCE_USER_KEY = 'private-test-key';
    try {
      const result = await collectWorkspaceEvidence({
        repo, baseRef, command: [process.execPath, '-e', 'process.exit(process.env.EVIDENCE_USER_KEY ? 9 : 0)'], stdio: 'ignore',
      });
      assert.equal(result.validation.passed, true);
    } finally {
      if (previous === undefined) delete process.env.EVIDENCE_USER_KEY;
      else process.env.EVIDENCE_USER_KEY = previous;
    }
  });
});

test('CLI requires an explicit run, claim, and command; no implicit shell', () => {
  assert.throws(() => parseArguments(['--run-id', 'run_1', '--', 'echo', 'ok']), /claim/);
  assert.throws(() => parseArguments(['--run-id', 'run_1', '--claim-id', 'claim_1']), /command/);
  const args = parseArguments(['--run-id', 'run_1', '--claim-id', 'claim_1', '--close', '--', 'echo', 'a; rm x']);
  assert.deepEqual(args.command, ['echo', 'a; rm x']);
  assert.equal(args.close, true);
});

test('a command changing the tested workspace cannot certify the final diff', async () => {
  await repository(async (repo, baseRef) => {
    const result = await collectWorkspaceEvidence({
      repo, baseRef, command: [process.execPath, '-e', 'require("node:fs").writeFileSync("source.txt", "changed during validation")'], stdio: 'ignore',
    });
    assert.equal(result.validation.exit_code, 0);
    assert.equal(result.validation.passed, false);
    assert.equal(result.behavior.result_summary, 'workspace_changed_during_validation');
  });
});

test('foreign claims and closed runs are rejected before executing or uploading', async () => {
  const options = { runId: 'run-1', claimIds: ['foreign'], command: ['must-not-execute'] };
  const calls = [];
  const post = async (route) => {
    calls.push(route);
    return { run: { status: 'running' }, claims: [{ run_id: 'another-run', claim_id: 'foreign' }] };
  };
  await assert.rejects(captureAndRecord(options, post), /Claim does not belong/);
  assert.deepEqual(calls, ['task-runs/get']);
  await assert.rejects(captureAndRecord(options, async () => ({ run: { status: 'completed' } })), /Run is closed/);
});
