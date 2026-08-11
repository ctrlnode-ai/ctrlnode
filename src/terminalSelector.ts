import { emitKeypressEvents } from 'readline';

type TerminalKey = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
};

export type TerminalSelectorOptions = {
  optionCount: number;
  initialIndex?: number;
  render: (selectedIndex: number) => string[];
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

export function canUseTerminalSelector(input: NodeJS.ReadStream = process.stdin): boolean {
  return Boolean(input.isTTY && typeof input.setRawMode === 'function');
}

export function selectTerminalOption(options: TerminalSelectorOptions): Promise<number | null> {
  if (options.optionCount < 1) throw new Error('optionCount must be at least 1');

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const initialIndex = Math.max(0, Math.min(options.initialIndex ?? 0, options.optionCount - 1));
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  let selectedIndex = initialIndex;
  let renderedLineCount = 0;

  return new Promise(resolve => {
    const render = (redraw: boolean) => {
      const lines = options.render(selectedIndex);
      if (redraw) {
        const cursorUp = renderedLineCount > 1 ? `\u001b[${renderedLineCount - 1}A` : '';
        output.write(`\r${cursorUp}\u001b[0J`);
      }
      output.write(lines.join('\n'));
      renderedLineCount = lines.length;
    };

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (!wasRaw) input.setRawMode(false);
      if (wasPaused) input.pause();
    };

    const finish = (result: number | null) => {
      cleanup();
      output.write('\n');
      resolve(result);
    };

    const onKeypress = (value: string, key: TerminalKey = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish(null);
        return;
      }

      const digit = key.sequence || value;
      if (digit === '1' || digit === '2') {
        const directIndex = Number(digit) - 1;
        if (directIndex < options.optionCount) finish(directIndex);
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        finish(selectedIndex);
        return;
      }

      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.optionCount) % options.optionCount;
        render(true);
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.optionCount;
        render(true);
      }
    };

    emitKeypressEvents(input);
    input.on('keypress', onKeypress);
    if (wasPaused) input.resume();
    if (!wasRaw) input.setRawMode(true);
    render(false);
  });
}
