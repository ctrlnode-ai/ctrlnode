import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import {
  renderWelcomePanel,
  renderWorkspaceTrustPanel,
  supportsTerminalColor,
  visibleWidth,
} from '../terminalPanels.js';

describe('supportsTerminalColor', () => {
  test('requires an interactive terminal and honors NO_COLOR', () => {
    expect(supportsTerminalColor({ isTTY: true })).toBe(true);
    expect(supportsTerminalColor({ isTTY: false })).toBe(false);
    expect(supportsTerminalColor({ isTTY: true, noColor: '1' })).toBe(false);
    expect(supportsTerminalColor({ isTTY: true, term: 'dumb' })).toBe(false);
  });
});

describe('renderWorkspaceTrustPanel', () => {
  test('renders the approved boxed trust content', () => {
    const output = renderWorkspaceTrustPanel({
      cwd: 'C:\\CTRLNODE_EXAMPLE',
      boxed: true,
      color: false,
      columns: 80,
    }).join('\n');

    expect(output).toContain('■──■');
    expect(output).not.toContain('▪ ▪');
    expect(output).toContain('CTRLNODE · WORKSPACE TRUST');
    expect(output).toContain('C:\\CTRLNODE_EXAMPLE');
    expect(output).toContain('› 1  Yes, continue');
    expect(output).toContain('2  No, choose another directory');
    expect(output).not.toContain('project-local config');
  });

  test('adds cyan ANSI styling without changing visible alignment', () => {
    const lines = renderWorkspaceTrustPanel({
      cwd: 'C:\\CTRLNODE_EXAMPLE',
      boxed: true,
      color: true,
      columns: 80,
    });

    expect(lines.join('\n')).toContain('\u001b[36m');
    expect(new Set(lines.map(visibleWidth))).toEqual(new Set([80]));
  });

  test('moves the cyan selection marker and full-row styling', () => {
    const first = renderWorkspaceTrustPanel({
      cwd: 'C:\\CTRLNODE_EXAMPLE', boxed: true, color: true, columns: 80, selectedIndex: 0,
    }).join('\n');
    const second = renderWorkspaceTrustPanel({
      cwd: 'C:\\CTRLNODE_EXAMPLE', boxed: true, color: true, columns: 80, selectedIndex: 1,
    }).join('\n');

    expect(first).toContain('\u001b[36m › 1  Yes, continue');
    expect(second).toContain('\u001b[36m › 2  No, choose another directory');
    expect(second).not.toContain('› 1  Yes, continue');
  });

  test('keeps boxed output uncolored when color is disabled', () => {
    const output = renderWorkspaceTrustPanel({
      cwd: 'C:\\CTRLNODE_EXAMPLE',
      boxed: true,
      color: false,
      columns: 80,
    }).join('\n');

    expect(output).not.toContain('\u001b[');
    expect(output).toContain('┌');
  });

  test('wraps long paths inside a narrow panel', () => {
    const lines = renderWorkspaceTrustPanel({
      cwd: 'C:\\a-very-long-workspace-name\\another-long-directory\\project',
      boxed: true,
      color: false,
      columns: 52,
    });

    expect(Math.max(...lines.map(visibleWidth))).toBe(52);
    expect(lines.length).toBeGreaterThan(12);
  });

  test('returns readable unboxed text for redirected output', () => {
    const output = renderWorkspaceTrustPanel({
      cwd: '/srv/ctrlnode',
      boxed: false,
      color: false,
      columns: 80,
    }).join('\n');

    expect(output).toContain('CTRLNODE · WORKSPACE TRUST');
    expect(output).toContain('/srv/ctrlnode');
    expect(output).not.toContain('┌');
    expect(output).not.toContain('\u001b[');
  });
});

describe('renderWelcomePanel', () => {
  test('renders the startup summary', () => {
    const output = renderWelcomePanel({
      workspace: 'C:\\CTRLNODE_EXAMPLE',
      configPath: 'C:\\Users\\VIL\\.ctrlnode\\.env',
      providerCount: 8,
      version: 'v2026.3.0',
      boxed: true,
      color: false,
      columns: 80,
    }).join('\n');

    expect(output).toContain('■──■');
    expect(output).not.toContain('▪ ▪');
    expect(output).toContain('Welcome to CTRLNODE!');
    expect(output).toContain('Connecting your local AI agents.');
    expect(output).toContain('Workspace:');
    expect(output).toContain('C:\\CTRLNODE_EXAMPLE');
    expect(output).toContain('Config:');
    expect(output).toContain('8 enabled');
    expect(output).toContain('v2026.3.0');
  });

  test('normal startup uses the welcome panel instead of the legacy banner', () => {
    const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain('renderWelcomePanel');
    expect(source).not.toContain('CTRLNODE Bridge ${BRIDGE_VERSION}');
  });
});
