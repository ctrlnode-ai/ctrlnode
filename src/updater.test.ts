import { describe, expect, it } from 'bun:test';
import { isNewerVersion } from './updater.js';

describe('isNewerVersion', () => {
  it('returns true when remote minor is higher', () => {
    expect(isNewerVersion('2026.2.3', '2026.2.4')).toBe(true);
  });
  it('returns true when remote major is higher', () => {
    expect(isNewerVersion('2026.2.3', '2026.3.0')).toBe(true);
  });
  it('returns true when remote year is higher', () => {
    expect(isNewerVersion('2026.2.3', '2027.1.0')).toBe(true);
  });
  it('returns false when versions are equal', () => {
    expect(isNewerVersion('2026.2.4', '2026.2.4')).toBe(false);
  });
  it('returns false when local is newer', () => {
    expect(isNewerVersion('2026.2.5', '2026.2.4')).toBe(false);
  });
  it('handles v-prefix in remote version', () => {
    expect(isNewerVersion('2026.2.3', 'v2026.2.4')).toBe(true);
  });
  it('handles v-prefix in local version', () => {
    expect(isNewerVersion('v2026.2.3', '2026.2.4')).toBe(true);
  });
});
