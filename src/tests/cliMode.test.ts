import { describe, expect, test } from 'bun:test';
import { isLoginCommand } from '../cliMode.js';

describe('isLoginCommand', () => {
  test('recognizes the login subcommand', () => {
    expect(isLoginCommand(['bun', 'index.ts', 'login'])).toBe(true);
  });

  test('recognizes the --login flag', () => {
    expect(isLoginCommand(['bun', 'index.ts', '--login'])).toBe(true);
  });

  test('does not classify normal Bridge startup as login', () => {
    expect(isLoginCommand(['bun', 'index.ts'])).toBe(false);
  });
});
