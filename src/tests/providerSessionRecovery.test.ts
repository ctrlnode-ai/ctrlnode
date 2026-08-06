// @ts-nocheck
import { describe, expect, test, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isStaleSessionError,
  buildStaleSessionRecoveryPrompt,
} from '../providers/providerFileUtils';

describe('isStaleSessionError', () => {
  test('matches the Claude CLI "no conversation found" message', () => {
    expect(isStaleSessionError('No conversation found with session ID: c61dd641-d209-45a2-ae17-9cf33c4f802c')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isStaleSessionError('ERROR: no CONVERSATION found with session id: abc')).toBe(true);
  });

  test('matches when embedded in a larger stderr blob', () => {
    const stderr = 'some preamble\nNo conversation found with session ID: xyz\nmore noise';
    expect(isStaleSessionError(stderr)).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    expect(isStaleSessionError('Error: ENOENT: no such file or directory')).toBe(false);
  });

  test('returns false for empty/undefined text', () => {
    expect(isStaleSessionError('')).toBe(false);
  });
});

describe('buildStaleSessionRecoveryPrompt', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('prepends agent_log.md content as prior context when the log exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-test-'));
    const agentLogPath = path.join(tmpDir, 'agent_log.md');
    fs.writeFileSync(agentLogPath, '# Agent log\n\nDid the first half of the task.', 'utf-8');

    const result = buildStaleSessionRecoveryPrompt(agentLogPath, 'please continue');

    expect(result).toContain('Did the first half of the task.');
    expect(result).toContain('please continue');
    expect(result).toContain('previous conversation history is unavailable');
  });

  test('falls back to the original prompt when agent_log.md does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-test-'));
    const agentLogPath = path.join(tmpDir, 'agent_log.md');

    const result = buildStaleSessionRecoveryPrompt(agentLogPath, 'please continue');

    expect(result).toBe('please continue');
  });

  test('falls back to the original prompt when agent_log.md is empty', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-test-'));
    const agentLogPath = path.join(tmpDir, 'agent_log.md');
    fs.writeFileSync(agentLogPath, '   \n  ', 'utf-8');

    const result = buildStaleSessionRecoveryPrompt(agentLogPath, 'please continue');

    expect(result).toBe('please continue');
  });

  test('accepts a task folder path and includes every prior execution log, not just the latest', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-test-'));
    const outputDir = path.join(tmpDir, 'output');
    const inputDir = path.join(tmpDir, 'input');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'agent_log.md'), 'Did the first half of the task.', 'utf-8');
    fs.writeFileSync(path.join(inputDir, 'abc-followup-1.md'), 'follow up', 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'agent_log.followup-1.md'), 'Did the second half.', 'utf-8');

    const result = buildStaleSessionRecoveryPrompt(tmpDir, 'please continue');

    expect(result).toContain('Did the first half of the task.');
    expect(result).toContain('Did the second half.');
    expect(result).toContain('please continue');
  });

  test('falls back to the original prompt when the task folder has no logs at all', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-test-'));
    const result = buildStaleSessionRecoveryPrompt(tmpDir, 'please continue');
    expect(result).toBe('please continue');
  });
});
