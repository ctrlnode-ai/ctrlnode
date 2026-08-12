const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const CYAN = '\u001b[36m';
const BRIGHT_CYAN = '\u001b[96m';
const GREEN = '\u001b[32m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

type TerminalColorInput = {
  isTTY?: boolean;
  noColor?: string;
  term?: string;
};

type PanelOptions = {
  boxed: boolean;
  color: boolean;
  columns?: number;
};

export type WorkspaceTrustPanelOptions = PanelOptions & {
  cwd: string;
  selectedIndex?: number;
};

export type WelcomePanelOptions = PanelOptions & {
  workspace: string;
  configPath: string;
  providerCount: number;
  version: string;
};

export function supportsTerminalColor(input: TerminalColorInput = {}): boolean {
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY);
  const noColor = input.noColor ?? process.env.NO_COLOR;
  const term = input.term ?? process.env.TERM;
  return isTTY && noColor === undefined && term?.toLowerCase() !== 'dumb';
}

export function visibleWidth(value: string): number {
  return value.replace(ANSI_PATTERN, '').length;
}

function wrapText(value: string, width: number): string[] {
  if (!value) return [''];
  if (value.length <= width) return [value];
  const lines: string[] = [];
  let current = '';

  for (const sourceWord of value.split(/\s+/)) {
    const chunks: string[] = [];
    let word = sourceWord;
    while (word.length > width) {
      chunks.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (word) chunks.push(word);

    for (const chunk of chunks) {
      if (!current) {
        current = chunk;
      } else if (current.length + 1 + chunk.length <= width) {
        current += ` ${chunk}`;
      } else {
        lines.push(current);
        current = chunk;
      }
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function styleContent(value: string): string {
  let styled = value;
  styled = styled.replace(/■──■/, `${CYAN}■──■${RESET}`);
  styled = styled.replace(/(CTRLNODE · WORKSPACE TRUST|Welcome to CTRLNODE!)/, `${BRIGHT_CYAN}$1${RESET}`);
  styled = styled.replace(/^(\s*)›/, `$1${CYAN}›${RESET}`);
  styled = styled.replace(/^(\s*)(Workspace:|Config:|Providers:|Version:)/, `$1${CYAN}$2${RESET}`);
  styled = styled.replace(/(\d+ enabled)/, `${GREEN}$1${RESET}`);
  styled = styled.replace(/(Connecting your local AI agents\.)/, `${DIM}$1${RESET}`);
  return styled;
}

function renderPanel(rows: string[], options: PanelOptions): string[] {
  if (!options.boxed) return rows;

  const width = Math.max(48, Math.min(options.columns ?? 80, 100));
  const innerWidth = width - 4;
  const wrappedRows = rows.flatMap(row => wrapText(row, innerWidth));
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const bottom = `└${'─'.repeat(width - 2)}┘`;
  const content = wrappedRows.map(row => `│ ${row}${' '.repeat(innerWidth - row.length)} │`);

  if (!options.color) return [top, ...content, bottom];

  return [
    `${CYAN}${top}${RESET}`,
    ...content.map(line => {
      const plainBody = line.slice(1, -1);
      const body = plainBody.includes('›')
        ? `${CYAN}${plainBody}${RESET}`
        : styleContent(plainBody);
      return `${CYAN}│${RESET}${body}${CYAN}│${RESET}`;
    }),
    `${CYAN}${bottom}${RESET}`,
  ];
}

export function renderWorkspaceTrustPanel(options: WorkspaceTrustPanelOptions): string[] {
  const selectedIndex = options.selectedIndex ?? 0;
  return renderPanel([
    '■──■  CTRLNODE · WORKSPACE TRUST',
    '',
    'You are in',
    options.cwd,
    '',
    'Do you trust the contents of this directory?',
    'Working with untrusted contents comes with higher risk of prompt injection.',
    '',
    `${selectedIndex === 0 ? '›' : ' '} 1  Yes, continue`,
    `${selectedIndex === 1 ? '›' : ' '} 2  No, choose another directory`,
  ], options);
}

export function renderWelcomePanel(options: WelcomePanelOptions): string[] {
  return renderPanel([
    '■──■  Welcome to CTRLNODE!',
    '     Connecting your local AI agents.',
    '',
    `Workspace: ${options.workspace}`,
    `Config: ${options.configPath}`,
    `Providers: ${options.providerCount} enabled`,
    `Version: ${options.version}`,
  ], options);
}
