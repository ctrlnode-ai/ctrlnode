import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { selectTerminalOption } from '../terminalSelector.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  rawModeCalls: boolean[] = [];

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.rawModeCalls.push(enabled);
    return this;
  }

  isPaused(): boolean {
    return this.paused;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

class FakeOutput {
  writes: string[] = [];

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}

function startSelection(initialIndex = 0) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const renderedSelections: number[] = [];
  const selection = selectTerminalOption({
    optionCount: 2,
    initialIndex,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    render: selectedIndex => {
      renderedSelections.push(selectedIndex);
      return [`panel-${selectedIndex}`, 'option-row'];
    },
  });
  return { input, output, renderedSelections, selection };
}

describe('selectTerminalOption', () => {
  test('moves down and confirms with Enter', async () => {
    const runtime = startSelection();

    runtime.input.emit('keypress', '', { name: 'down' });
    runtime.input.emit('keypress', '', { name: 'return' });

    expect(await runtime.selection).toBe(1);
    expect(runtime.renderedSelections).toEqual([0, 1]);
  });

  test('wraps Up from the first option to the last', async () => {
    const runtime = startSelection();

    runtime.input.emit('keypress', '', { name: 'up' });
    runtime.input.emit('keypress', '', { name: 'return' });

    expect(await runtime.selection).toBe(1);
  });

  test('wraps Down from the last option to the first', async () => {
    const runtime = startSelection(1);

    runtime.input.emit('keypress', '', { name: 'down' });
    runtime.input.emit('keypress', '', { name: 'return' });

    expect(await runtime.selection).toBe(0);
  });

  test('confirms immediately with numeric shortcuts', async () => {
    const first = startSelection(1);
    first.input.emit('keypress', '1', { name: '1', sequence: '1' });
    expect(await first.selection).toBe(0);

    const second = startSelection();
    second.input.emit('keypress', '2', { name: '2', sequence: '2' });
    expect(await second.selection).toBe(1);
  });

  test('returns null for Ctrl+C and restores terminal state', async () => {
    const runtime = startSelection();

    runtime.input.emit('keypress', '\u0003', { name: 'c', ctrl: true });

    expect(await runtime.selection).toBeNull();
    expect(runtime.input.rawModeCalls).toEqual([true, false]);
    expect(runtime.input.paused).toBe(true);
    expect(runtime.input.listenerCount('keypress')).toBe(0);
  });

  test('redraws in place after navigation', async () => {
    const runtime = startSelection();

    runtime.input.emit('keypress', '', { name: 'down' });
    runtime.input.emit('keypress', '', { name: 'return' });
    await runtime.selection;

    expect(runtime.output.writes.join('')).toContain('\u001b[1A');
    expect(runtime.output.writes.join('')).toContain('\u001b[0J');
  });
});
