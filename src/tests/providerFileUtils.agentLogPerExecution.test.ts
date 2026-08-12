import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  agentLogFileNameForFollowup,
  resolveCurrentAgentLogFileName,
  readAllAgentLogsForContext,
  writeAgentLog,
  prepareFollowupFiles,
} from '../providers/providerFileUtils.js';
import { CTRLNODE_ROOT } from '../config.js';

describe('agentLogFileNameForFollowup', () => {
  test('returns agent_log.md for the initial run (n=0)', () => {
    expect(agentLogFileNameForFollowup(0)).toBe('agent_log.md');
  });

  test('returns agent_log.followup-N.md for followup N', () => {
    expect(agentLogFileNameForFollowup(1)).toBe('agent_log.followup-1.md');
    expect(agentLogFileNameForFollowup(2)).toBe('agent_log.followup-2.md');
  });
});

describe('resolveCurrentAgentLogFileName / readAllAgentLogsForContext', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resolves agent_log.md when no followup inputs exist yet', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    expect(resolveCurrentAgentLogFileName(tmpDir)).toBe('agent_log.md');
  });

  test('resolves agent_log.followup-1.md once one followup input file exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    const inputDir = path.join(tmpDir, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'abc-followup-1.md'), 'hi', 'utf-8');
    expect(resolveCurrentAgentLogFileName(tmpDir)).toBe('agent_log.followup-1.md');
  });

  test('readAllAgentLogsForContext returns empty string when no logs exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    expect(readAllAgentLogsForContext(tmpDir)).toBe('');
  });

  test('readAllAgentLogsForContext concatenates initial run + all followup logs in order', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // Two followups already happened (2 followup input files on disk)
    fs.writeFileSync(path.join(inputDir, 'abc-followup-1.md'), 'f1', 'utf-8');
    fs.writeFileSync(path.join(inputDir, 'abc-followup-2.md'), 'f2', 'utf-8');

    fs.writeFileSync(path.join(outputDir, 'agent_log.md'), 'initial run log', 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'agent_log.followup-1.md'), 'followup 1 log', 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'agent_log.followup-2.md'), 'followup 2 log', 'utf-8');

    const result = readAllAgentLogsForContext(tmpDir);
    const initialIdx = result.indexOf('initial run log');
    const f1Idx = result.indexOf('followup 1 log');
    const f2Idx = result.indexOf('followup 2 log');

    expect(initialIdx).toBeGreaterThanOrEqual(0);
    expect(f1Idx).toBeGreaterThan(initialIdx);
    expect(f2Idx).toBeGreaterThan(f1Idx);
  });

  test('readAllAgentLogsForContext skips missing intermediate logs without throwing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'abc-followup-1.md'), 'f1', 'utf-8');
    // Only followup-1's log exists; initial run's agent_log.md is missing.
    fs.writeFileSync(path.join(outputDir, 'agent_log.followup-1.md'), 'followup 1 log', 'utf-8');

    const result = readAllAgentLogsForContext(tmpDir);
    expect(result).toContain('followup 1 log');
  });

  test('writeAgentLog writes to the given logFileName instead of always agent_log.md', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    writeAgentLog('task-1', tmpDir, 'followup content', 'test_provider', 'agent_log.followup-1.md');
    const written = fs.readFileSync(path.join(tmpDir, 'output', 'agent_log.followup-1.md'), 'utf-8');
    expect(written).toBe('followup content');
    expect(fs.existsSync(path.join(tmpDir, 'output', 'agent_log.md'))).toBe(false);
  });

  test('writeAgentLog defaults to agent_log.md when logFileName is omitted', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-test-'));
    writeAgentLog('task-1', tmpDir, 'initial content', 'test_provider');
    const written = fs.readFileSync(path.join(tmpDir, 'output', 'agent_log.md'), 'utf-8');
    expect(written).toBe('initial content');
  });
});

describe('prepareFollowupFiles — full history in followupLogBlockWithHistory', () => {
  test('includes every prior execution log (initial + earlier followups), not just the latest', () => {
    // prepareFollowupFiles resolves an unset taskFolderName to CTRLNODE_ROOT/tasks/<taskId>,
    // so we simulate prior logs directly under that resolved path.
    const taskId = `test-task-${Date.now()}`;
    const taskFolderAbs = path.join(CTRLNODE_ROOT, 'tasks', taskId);
    const outputDir = path.join(taskFolderAbs, 'output');
    const inputDir = path.join(taskFolderAbs, 'input');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'agent_log.md'), 'INITIAL_RUN_MARKER', 'utf-8');
    const shortId = taskId.slice(0, 8).split('-')[0];
    fs.writeFileSync(path.join(inputDir, `${shortId}-followup-1.md`), 'prior followup message', 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'agent_log.followup-1.md'), 'FOLLOWUP_1_MARKER', 'utf-8');

    try {
      const result = prepareFollowupFiles(taskId, 'second follow-up message', undefined);
      expect(result.followupN).toBe(2);
      expect(result.followupLogBlockWithHistory).toContain('INITIAL_RUN_MARKER');
      expect(result.followupLogBlockWithHistory).toContain('FOLLOWUP_1_MARKER');
    } finally {
      fs.rmSync(taskFolderAbs, { recursive: true, force: true });
    }
  });
});
