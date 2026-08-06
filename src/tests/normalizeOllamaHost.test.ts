import { describe, expect, test } from 'bun:test';
import { normalizeOllamaHost } from '../config.js';

describe('normalizeOllamaHost', () => {
  test('defaults to localhost:11434 when unset', () => {
    expect(normalizeOllamaHost(undefined)).toBe('http://localhost:11434');
  });

  test('defaults to localhost:11434 when blank', () => {
    expect(normalizeOllamaHost('   ')).toBe('http://localhost:11434');
  });

  test('rewrites a bare 0.0.0.0 bind address to localhost', () => {
    expect(normalizeOllamaHost('0.0.0.0')).toBe('http://localhost:11434');
  });

  test('rewrites 0.0.0.0 with an explicit port to localhost, keeping the port', () => {
    expect(normalizeOllamaHost('0.0.0.0:11500')).toBe('http://localhost:11500');
  });

  test('adds http:// scheme to a bare host', () => {
    expect(normalizeOllamaHost('myhost')).toBe('http://myhost:11434');
  });

  test('adds default port when missing', () => {
    expect(normalizeOllamaHost('http://myhost')).toBe('http://myhost:11434');
  });

  test('leaves an already-valid URL untouched', () => {
    expect(normalizeOllamaHost('http://192.168.1.50:11434')).toBe('http://192.168.1.50:11434');
  });

  test('preserves https scheme', () => {
    expect(normalizeOllamaHost('https://myhost:11434')).toBe('https://myhost:11434');
  });
});
